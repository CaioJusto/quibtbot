import { statfs as statfsAsync } from "node:fs/promises";
import type { DockerInvocation } from "./docker-invocation.js";
import { runDockerCommand } from "./docker-invocation.js";
import { explainDockerFailure } from "./failure-messages.js";
import type { Clock, ProcessRunner, ProcessRunResult } from "./orchestrator.js";

/**
 * Sem TTY o `docker pull` não imprime nada enquanto uma camada baixa ou descompacta: a
 * camada do apt do quibt-computer (chromium + ffmpeg + xvfb, centenas de MB) fica muda
 * por minutos numa conexão doméstica. Três minutos matavam um download que estava indo
 * bem; quinze cobrem uma camada de ~500 MB a 5 Mbps. O teto absoluto de uma hora por
 * imagem continua protegendo contra um travamento de verdade.
 */
export const PULL_INACTIVITY_TIMEOUT_MS = 15 * 60_000;
/** Teto absoluto por imagem: numa conexão lenta 1,7 GB leva mesmo muito tempo. */
export const PULL_ABSOLUTE_TIMEOUT_MS = 60 * 60_000;
/** Enquanto a saída está muda, um sinal de vida com o tempo decorrido na camada. */
export const PULL_HEARTBEAT_INTERVAL_MS = 10_000;
/** As camadas ficam em cache no Docker: tentar de novo custa só o que faltou. */
export const PULL_ATTEMPTS = 3;
export const PULL_RETRY_DELAYS_MS = [5_000, 15_000] as const;
/** As três imagens somam ~1,7 GB comprimidos e ~10 GB descompactadas no disco. */
export const REQUIRED_FREE_BYTES = 10_000_000_000;
/** Uma retomada não precisa de 10 GB: o que já baixou continua no disco. */
export const MIN_REQUIRED_FREE_BYTES = 2_000_000_000;
/** O que sai da rede quando é tudo novo; a base para o aviso de uma retomada. */
export const TOTAL_DOWNLOAD_BYTES = 1_700_000_000;
export const DOWNLOAD_NOTICE =
  "Vou baixar cerca de 1,7 GB (≈10 GB em disco). Pode levar alguns minutos, dependendo da internet.";
export const NOTHING_TO_DOWNLOAD_NOTICE = "As imagens já estão neste computador; nada para baixar.";

export interface PullProgress {
  image: string;
  /** A referência já curta, pronta para a tela (sem o @sha256 de 64 caracteres). */
  label: string;
  index: number;
  count: number;
  layersDone: number;
  layersTotal: number;
  /** Há quanto tempo o docker não imprime nada; só nos sinais de vida. */
  quietMs?: number;
}

/**
 * Sem TTY o `docker pull` imprime uma linha por camada: "<id>: Pulling fs layer",
 * "<id>: Already exists", "<id>: Pull complete". Contar ids dá um progresso honesto
 * (camadas feitas/total) sem depender das barras que só aparecem num terminal.
 */
export class PullLayerTracker {
  private readonly layers = new Map<string, "pending" | "done">();

  /** Devolve true quando as contagens mudaram e vale emitir progresso. */
  observe(line: string): boolean {
    const match = /^([0-9a-f]{6,64}): (.+)$/.exec(line.trim());
    if (!match) return false;
    const id = match[1] as string;
    const status = (match[2] as string).trim();
    const before = this.snapshot();
    if (status === "Already exists" || status === "Pull complete") {
      this.layers.set(id, "done");
    } else if (!this.layers.has(id)) {
      this.layers.set(id, "pending");
    }
    const after = this.snapshot();
    return before.done !== after.done || before.total !== after.total;
  }

  snapshot(): { done: number; total: number } {
    let done = 0;
    for (const state of this.layers.values()) {
      if (state === "done") done += 1;
    }
    return { done, total: this.layers.size };
  }
}

/** "ghcr.io/quibt/quibt-stack:0.2.11" → "quibt-stack:0.2.11"; digests ficam curtos. */
export function shortImageName(reference: string): string {
  const name = reference.slice(reference.lastIndexOf("/") + 1);
  const digest = name.indexOf("@sha256:");
  if (digest >= 0) return `${name.slice(0, digest)}@${name.slice(digest + 8, digest + 20)}`;
  return name;
}

/** "80s" vira "1m20s": o tempo que a pessoa lê enquanto espera. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

function slotPrefix(progress: PullProgress): string {
  return progress.count > 1 ? `imagem ${progress.index} de ${progress.count}: ` : "";
}

export function progressMessage(progress: PullProgress): string {
  const where = slotPrefix(progress);
  if (progress.layersTotal === 0) return `Baixando ${where}${progress.label}…`;
  return `Baixando ${where}${progress.label} — ${progress.layersDone}/${progress.layersTotal} camadas`;
}

/**
 * O download está vivo, o Docker é que é calado. Sem esta frase a barra do desktop e a
 * saída do CLI ficam paradas por minutos e parecem travadas.
 */
export function quietProgressMessage(progress: PullProgress, quietMs: number): string {
  const where = slotPrefix(progress);
  const elapsed = formatElapsed(quietMs);
  if (progress.layersTotal === 0) {
    return `Baixando ${where}${progress.label} — sem novidade há ${elapsed}; o download continua.`;
  }
  const layer = Math.min(progress.layersDone + 1, progress.layersTotal);
  return `Baixando ${where}${progress.label} — baixando a camada ${layer} de ${progress.layersTotal} há ${elapsed}…`;
}

/** O aviso de tamanho só vale inteiro quando não há nada no disco ainda. */
export function downloadNotice(missing: number, total: number): string {
  if (total <= 0 || missing >= total) return DOWNLOAD_NOTICE;
  const bytes = Math.round((TOTAL_DOWNLOAD_BYTES * missing) / total);
  const what =
    missing === 1 ? `Falta 1 imagem de ${total}` : `Faltam ${missing} imagens de ${total}`;
  return `${what} (cerca de ${formatGigabytes(bytes)}). O resto já está no disco.`;
}

/**
 * `docker compose config --images` resolve o manifesto do jeito que o Compose vai usar:
 * troca `${QUIBT_STACK_VERSION}`, respeita digests fixos do binário de release e só
 * inclui o Caddy quando o profile público está ligado. Falhou ou veio vazio: devolve [].
 */
export async function listComposeImages(
  run: ProcessRunner,
  docker: DockerInvocation,
  args: string[],
  cwd?: string,
): Promise<string[]> {
  const result = await runDockerCommand(run, docker, args, { cwd, timeoutMs: 60_000 });
  if (result.code !== 0) return [];
  const seen = new Set<string>();
  for (const raw of result.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line && !line.startsWith("WARN")) seen.add(line);
  }
  return [...seen];
}

/** Já está aqui? `docker image inspect` é a única resposta que não depende da rede. */
export async function imageExistsLocally(
  run: ProcessRunner,
  docker: DockerInvocation,
  reference: string,
): Promise<boolean> {
  const inspected = await runDockerCommand(
    run,
    docker,
    ["image", "inspect", "-f", "{{.Id}}", reference],
    { timeoutMs: 30_000 },
  );
  return inspected.code === 0 && Boolean(inspected.stdout.trim());
}

/**
 * As que faltam, na ordem da lista. Filtrar antes do download deixa honestos o aviso de
 * tamanho e o "imagem N de M", e evita exigir 10 GB livres numa retomada em que a maior
 * parte desses 10 GB já é ocupada pelas imagens baixadas.
 */
export async function missingImagesLocally(
  run: ProcessRunner,
  docker: DockerInvocation,
  references: string[],
): Promise<string[]> {
  const missing: string[] = [];
  for (const reference of references) {
    if (!(await imageExistsLocally(run, docker, reference))) missing.push(reference);
  }
  return missing;
}

export type StatfsLike = (
  path: string,
) => Promise<{ bsize: number | bigint; bavail: number | bigint }>;

export const defaultStatfs: StatfsLike = (path) => statfsAsync(path);

export type DiskSpaceCheck =
  | { ok: true }
  | { ok: false; path: string; freeBytes: number; missingBytes: number; message: string };

export function formatGigabytes(bytes: number): string {
  const gb = bytes / 1_000_000_000;
  const rounded = gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10;
  return `${rounded.toString().replace(".", ",")} GB`;
}

/**
 * Quanto disco exigir quando parte das imagens já está aqui: os 10 GB são o total
 * descompactado das quatro; cobrar tudo de novo numa retomada trancava quem tinha
 * acabado de baixar 7 GB. Nunca menos de 2 GB — uma imagem sozinha pesa isso.
 */
export function requiredFreeBytesFor(missing: number, total: number): number {
  if (total <= 0 || missing >= total) return REQUIRED_FREE_BYTES;
  const share = Math.round((REQUIRED_FREE_BYTES * missing) / total);
  return Math.max(MIN_REQUIRED_FREE_BYTES, share);
}

/**
 * Checa o espaço antes de baixar: descobrir no meio do pull que faltam 6 GB é a pior
 * hora. Caminhos que não dão para medir (o root do Docker fica dentro da VM no Mac)
 * são ignorados; o DATA_DIR está no mesmo disco e cobre esse caso.
 */
export async function checkDiskSpace(
  paths: string[],
  statfs: StatfsLike = defaultStatfs,
  requiredBytes = REQUIRED_FREE_BYTES,
): Promise<DiskSpaceCheck> {
  for (const target of paths) {
    if (!target) continue;
    let free: number;
    try {
      const stats = await statfs(target);
      free = Number(stats.bsize) * Number(stats.bavail);
    } catch {
      continue;
    }
    if (!Number.isFinite(free)) continue;
    if (free < requiredBytes) {
      const missingBytes = requiredBytes - free;
      return {
        ok: false,
        path: target,
        freeBytes: free,
        missingBytes,
        message: `Faltam ${formatGigabytes(missingBytes)} em ${target}: o Quibt Bot precisa de ${formatGigabytes(requiredBytes)} livres para as imagens (há ${formatGigabytes(free)}). Libere espaço e tente de novo.`,
      };
    }
  }
  return { ok: true };
}

export interface PullDeps {
  run: ProcessRunner;
  docker: DockerInvocation;
  clock: Pick<Clock, "sleep">;
  cwd?: string;
  onProgress: (progress: PullProgress, message: string) => void;
  onNotice: (message: string) => void;
  /** Só os testes trocam: a janela de silêncio tolerada. */
  inactivityTimeoutMs?: number;
  /** Só os testes trocam: de quanto em quanto tempo sai um sinal de vida. */
  heartbeatIntervalMs?: number;
  /** Só os testes trocam: o relógio que mede o silêncio. */
  now?: () => number;
}

export type PullOutcome =
  | { ok: true }
  | { ok: false; message: string; detail: string; image: string; attempts: number };

function timeoutReason(result: ProcessRunResult, inactivityMs: number): string | null {
  if (result.timedOut === "inactivity") {
    return `ficou ${Math.round(inactivityMs / 60_000)} minutos sem progresso`;
  }
  if (result.timedOut === "absolute") {
    return `passou de ${Math.round(PULL_ABSOLUTE_TIMEOUT_MS / 60_000)} minutos`;
  }
  return null;
}

function attemptFailureReason(result: ProcessRunResult, inactivityMs: number): string {
  return (
    timeoutReason(result, inactivityMs) ??
    explainDockerFailure(`${result.stderr}\n${result.stdout}`, { phase: "pull" }) ??
    "o Docker devolveu erro"
  );
}

/**
 * Um download longo com stdout em streaming, timeout por inatividade e até três
 * tentativas. `args` é o `pull <imagem>` ou, sem lista de imagens, o `compose pull`
 * inteiro; o progresso por camadas funciona igual nos dois.
 */
export async function pullWithProgress(
  deps: PullDeps,
  args: string[],
  slot: { image: string; index: number; count: number },
): Promise<PullOutcome> {
  const inactivityMs = deps.inactivityTimeoutMs ?? PULL_INACTIVITY_TIMEOUT_MS;
  const heartbeatMs = deps.heartbeatIntervalMs ?? PULL_HEARTBEAT_INTERVAL_MS;
  const now = deps.now ?? Date.now;
  const label = shortImageName(slot.image);
  let last: ProcessRunResult | null = null;
  for (let attempt = 1; attempt <= PULL_ATTEMPTS; attempt += 1) {
    const tracker = new PullLayerTracker();
    const snapshot = (quietMs?: number): PullProgress => {
      const { done, total } = tracker.snapshot();
      return {
        ...slot,
        label,
        layersDone: done,
        layersTotal: total,
        ...(quietMs ? { quietMs } : {}),
      };
    };
    const report = () => {
      const progress = snapshot();
      deps.onProgress(progress, progressMessage(progress));
    };
    report();
    let lastOutputAt = now();
    // A camada grande não imprime nada: sem isto a barra fica parada e parece travada.
    const heartbeat = setInterval(() => {
      const quiet = now() - lastOutputAt;
      if (quiet < heartbeatMs) return;
      const progress = snapshot(quiet);
      deps.onProgress(progress, quietProgressMessage(progress, quiet));
    }, heartbeatMs);
    heartbeat.unref?.();
    let result: ProcessRunResult;
    try {
      result = await runDockerCommand(deps.run, deps.docker, args, {
        cwd: deps.cwd,
        timeoutMs: PULL_ABSOLUTE_TIMEOUT_MS,
        inactivityTimeoutMs: inactivityMs,
        onOutput: (line) => {
          lastOutputAt = now();
          if (tracker.observe(line)) report();
        },
      });
    } finally {
      clearInterval(heartbeat);
    }
    if (result.code === 0) {
      const { total } = tracker.snapshot();
      if (total > 0) {
        deps.onProgress(
          { ...slot, label, layersDone: total, layersTotal: total },
          `${label} pronta`,
        );
      }
      return { ok: true };
    }
    last = result;
    const reason = attemptFailureReason(result, inactivityMs);
    if (attempt < PULL_ATTEMPTS) {
      const delay = PULL_RETRY_DELAYS_MS[attempt - 1] ?? 15_000;
      deps.onNotice(
        `O download de ${label} ${reason} (tentativa ${attempt} de ${PULL_ATTEMPTS}). Tentando de novo em ${Math.round(delay / 1000)} s — o que já baixou fica guardado.`,
      );
      await deps.clock.sleep(delay);
    }
  }
  const detail = `${last?.stderr ?? ""}\n${last?.stdout ?? ""}`.trim();
  const explained = last ? attemptFailureReason(last, inactivityMs) : "o Docker devolveu erro";
  return {
    ok: false,
    image: slot.image,
    attempts: PULL_ATTEMPTS,
    detail,
    // Neutra de propósito: isto também sai numa VPS por SSH, onde não há botão nenhum.
    message: `O download de ${label} falhou ${PULL_ATTEMPTS} vezes (${explained}). Confira a internet e rode a instalação de novo — o que já baixou fica guardado.`,
  };
}

/** Uma imagem por vez, com índice: "imagem 2 de 4". */
export async function pullImagesWithProgress(
  deps: PullDeps,
  images: string[],
): Promise<PullOutcome> {
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index] as string;
    const outcome = await pullWithProgress(deps, ["pull", image], {
      image,
      index: index + 1,
      count: images.length,
    });
    if (!outcome.ok) return outcome;
  }
  return { ok: true };
}
