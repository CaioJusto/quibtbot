import { statfs as statfsAsync } from "node:fs/promises";
import type { DockerInvocation } from "./docker-invocation.js";
import { runDockerCommand } from "./docker-invocation.js";
import { explainDockerFailure } from "./failure-messages.js";
import type { Clock, ProcessRunner, ProcessRunResult } from "./orchestrator.js";

/** Sem nenhuma linha nova por este tempo, o download é dado como travado e refeito. */
export const PULL_INACTIVITY_TIMEOUT_MS = 180_000;
/** Teto absoluto por imagem: numa conexão lenta 1,7 GB leva mesmo muito tempo. */
export const PULL_ABSOLUTE_TIMEOUT_MS = 60 * 60_000;
/** As camadas ficam em cache no Docker: tentar de novo custa só o que faltou. */
export const PULL_ATTEMPTS = 3;
export const PULL_RETRY_DELAYS_MS = [5_000, 15_000] as const;
/** As três imagens somam ~1,7 GB comprimidos e ~10 GB descompactadas no disco. */
export const REQUIRED_FREE_BYTES = 10_000_000_000;
export const DOWNLOAD_NOTICE =
  "Vou baixar cerca de 1,7 GB (≈10 GB em disco). Pode levar alguns minutos, dependendo da internet.";

export interface PullProgress {
  image: string;
  index: number;
  count: number;
  layersDone: number;
  layersTotal: number;
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

export function progressMessage(progress: PullProgress): string {
  const name = shortImageName(progress.image);
  const where = progress.count > 1 ? `imagem ${progress.index} de ${progress.count}: ` : "";
  if (progress.layersTotal === 0) return `Baixando ${where}${name}…`;
  return `Baixando ${where}${name} — ${progress.layersDone}/${progress.layersTotal} camadas`;
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
}

export type PullOutcome =
  | { ok: true }
  | { ok: false; message: string; detail: string; image: string; attempts: number };

function timeoutReason(result: ProcessRunResult): string | null {
  if (result.timedOut === "inactivity") {
    return `ficou ${Math.round(PULL_INACTIVITY_TIMEOUT_MS / 60_000)} minutos sem progresso`;
  }
  if (result.timedOut === "absolute") {
    return `passou de ${Math.round(PULL_ABSOLUTE_TIMEOUT_MS / 60_000)} minutos`;
  }
  return null;
}

function attemptFailureReason(result: ProcessRunResult): string {
  return (
    timeoutReason(result) ??
    explainDockerFailure(`${result.stderr}\n${result.stdout}`) ??
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
  let last: ProcessRunResult | null = null;
  for (let attempt = 1; attempt <= PULL_ATTEMPTS; attempt += 1) {
    const tracker = new PullLayerTracker();
    const report = () => {
      const { done, total } = tracker.snapshot();
      const progress: PullProgress = { ...slot, layersDone: done, layersTotal: total };
      deps.onProgress(progress, progressMessage(progress));
    };
    report();
    const result = await runDockerCommand(deps.run, deps.docker, args, {
      cwd: deps.cwd,
      timeoutMs: PULL_ABSOLUTE_TIMEOUT_MS,
      inactivityTimeoutMs: PULL_INACTIVITY_TIMEOUT_MS,
      onOutput: (line) => {
        if (tracker.observe(line)) report();
      },
    });
    if (result.code === 0) {
      const { total } = tracker.snapshot();
      if (total > 0) {
        deps.onProgress(
          { ...slot, layersDone: total, layersTotal: total },
          `${shortImageName(slot.image)} pronta`,
        );
      }
      return { ok: true };
    }
    last = result;
    const reason = attemptFailureReason(result);
    if (attempt < PULL_ATTEMPTS) {
      const delay = PULL_RETRY_DELAYS_MS[attempt - 1] ?? 15_000;
      deps.onNotice(
        `O download de ${shortImageName(slot.image)} ${reason} (tentativa ${attempt} de ${PULL_ATTEMPTS}). Tentando de novo em ${Math.round(delay / 1000)} s — o que já baixou fica guardado.`,
      );
      await deps.clock.sleep(delay);
    }
  }
  const detail = `${last?.stderr ?? ""}\n${last?.stdout ?? ""}`.trim();
  const explained = last ? attemptFailureReason(last) : "o Docker devolveu erro";
  return {
    ok: false,
    image: slot.image,
    attempts: PULL_ATTEMPTS,
    detail,
    message: `O download de ${shortImageName(slot.image)} falhou ${PULL_ATTEMPTS} vezes (${explained}). Confira a internet e clique em Começar instalação de novo — o que já baixou fica guardado.`,
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
