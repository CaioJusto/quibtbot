import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BOX_PUBLIC_PROXY_ENV, normalizeBoxHostedUrl } from "@quibt/core";
import {
  appServicesUpInvocation,
  type ComposeMode,
  composeInvocation,
  INSTALL_RELEASE,
  postgresUpInvocation,
  requiredQuibtImages,
  stackUpInvocation,
} from "./compose.js";
import { parseComposePsOutput } from "./compose-ps.js";
import type { DockerInvocation } from "./docker-invocation.js";
import { resolveDockerInvocation, runDockerCommand } from "./docker-invocation.js";
import { type DesktopInstallPolicy, ensureDocker } from "./docker-requirements.js";
import { ensureInstallEnvironment, parseEnvFile } from "./environment.js";
import {
  DOCKER_DESKTOP_GONE_MESSAGE,
  explainDockerFailure,
  explainInstallLock,
  explainUpdateRequired,
} from "./failure-messages.js";
import { missingImagesLocally, type PullProgress, type StatfsLike } from "./image-pull.js";
import { acquireInstallLock, releaseInstallLock } from "./install-lock.js";
import { migrateInvocation, migrationFailureMessage } from "./migrate.js";
import {
  apiBaseUrl,
  apiReadyUrl,
  CLAIMED_PAIRING_INSTRUCTION,
  fetchWithRetry,
  HTTP_TIMEOUT_MS,
  probeDeploymentNeedsFirstOwner,
  waitForReady,
} from "./orchestrator-helpers.js";
import type { SensitivePairingOutput } from "./pairing.js";
import { buildPairingOutput } from "./pairing.js";
import {
  decidePublicAccess,
  PUBLIC_HOST_ENV,
  type PublicAccessDecision,
  type PublicAccessInput,
} from "./public-access.js";
import { pullComposeImages } from "./pull-step.js";
import { redactInstallerText } from "./redact.js";
import { type InstallState, type InstallStep, nextInstallStep } from "./state.js";
import {
  completeInstallStep,
  initialInstallState,
  inspectInstallState,
  isInstallStateComplete,
  loadInstallState,
  saveInstallState,
} from "./state-persist.js";

export type InstallerEventStatus = "running" | "succeeded" | "failed";

export interface InstallerEvent {
  step: InstallStep;
  status: InstallerEventStatus;
  message: string;
  detail?: Record<string, unknown>;
  /** Download de imagem em andamento: quem mostra uma barra lê daqui. */
  progress?: PullProgress;
}

export type { PullProgress } from "./image-pull.js";

export interface ProcessRunResult {
  code: number;
  stdout: string;
  stderr: string;
  stdoutBytes?: Buffer;
  /** Preenchido quando o runner matou o processo por tempo (código 124). */
  timedOut?: "absolute" | "inactivity";
}

export interface ProcessRunOptions {
  cwd?: string;
  /** Teto absoluto. */
  timeoutMs?: number;
  /** Mata o processo depois deste tempo sem NENHUMA linha nova em stdout/stderr. */
  inactivityTimeoutMs?: number;
  /** Recebe cada linha assim que sai, para mostrar progresso de comandos longos. */
  onOutput?: (line: string, stream: "stdout" | "stderr") => void;
}

export interface ProcessRunner {
  run(command: string, args: string[], options?: ProcessRunOptions): Promise<ProcessRunResult>;
}

export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export interface InstallResult {
  ok: boolean;
  state: InstallState;
  pairing?: SensitivePairingOutput;
  pairingPending?: boolean;
  claimedInstruction?: string;
  error?: string;
  /** O texto técnico (stderr já sem segredos) por trás de `error`. */
  errorDetail?: string;
  exitCode?: number;
  /** O estado já estava completo: só religou o stack, sem instalar nada. */
  alreadyInstalled?: boolean;
  /** Endereço em que o stack ficou no ar (o mesmo que o celular recebe). */
  url?: string;
  /** Um `docker compose up` rodou nesta chamada. */
  servicesStarted?: boolean;
  /**
   * Religar não achou o Docker Desktop no Mac. Quem tem botão volta para o modo
   * instalação; religar nunca baixa o Docker por conta própria.
   */
  dockerMissing?: boolean;
}

export interface OrchestratorDeps {
  dataDir: string;
  publicUrl: string;
  /** `install --local`: fica em loopback mesmo com IP público e 80/443 livres. */
  forceLocal?: boolean;
  /**
   * Sem ninguém na frente da tela: nada de pedir a senha do Mac para instalar o
   * Docker Desktop — falha com uma frase clara em vez de abrir um prompt.
   */
  nonInteractive?: boolean;
  /** Só os testes trocam: mede o espaço livre antes do download. */
  statfs?: StatfsLike;
  /**
   * Liga a descoberta do endereço público. O CLI passa `{}` (rede de verdade); os
   * testes injetam `fetch`/`checkPort` falsos; quem omite fica em loopback sem
   * consultar nada.
   */
  publicAccess?: Pick<PublicAccessInput, "fetch" | "checkPort" | "random">;
  composeFile: string;
  composeMode: ComposeMode;
  run: ProcessRunner;
  fetch: typeof fetch;
  clock: Clock;
  platform?: NodeJS.Platform;
  docker?: DockerInvocation;
  onEvent?: (event: InstallerEvent) => void;
  onWarning?: (message: string) => void;
}

/**
 * O endereço que o CELULAR recebe: numa instalação pública é o https do Caddy, lido do
 * env. Vem do env, e não da decisão em memória, porque uma retomada (o install caiu
 * em `health` e voltou) pula o passo `environment` e a decisão nem existe — o pairing
 * entregava `http://127.0.0.1:5173` ao telefone, um endereço morto fora do host.
 */
export function reachableUrl(envValues: Record<string, string>, publicUrl: string): string {
  const proxyUrl = normalizeBoxHostedUrl(envValues[BOX_PUBLIC_PROXY_ENV] ?? "");
  if (proxyUrl) return proxyUrl;
  const host = envValues[PUBLIC_HOST_ENV]?.trim();
  return host ? `https://${host}` : publicUrl;
}

/** O host público de uma instalação anterior, se o env já existir. */
function readExistingPublicHost(dataDir: string): string | undefined {
  const file = envFilePath(dataDir);
  if (!existsSync(file)) return undefined;
  const host = parseEnvFile(readFileSync(file, "utf8"))[PUBLIC_HOST_ENV];
  return host ? host : undefined;
}

function envFilePath(dataDir: string): string {
  return path.join(path.resolve(dataDir), "quibt.env");
}

function loadEnvValues(dataDir: string): Record<string, string> {
  const target = envFilePath(dataDir);
  if (!existsSync(target)) return {};
  return parseEnvFile(readFileSync(target, "utf8"));
}

function collectSecrets(values: Record<string, string>): string[] {
  return [
    values.BETTER_AUTH_SECRET,
    values.ENCRYPTION_KEY,
    values.SANDBOX_SUPERVISOR_TOKEN,
    values.BOOTSTRAP_SECRET,
    values.DATABASE_PASSWORD,
  ].filter((value): value is string => Boolean(value));
}

function sanitizeDetail(
  detail: Record<string, unknown> | undefined,
  secrets: string[],
): Record<string, unknown> | undefined {
  if (!detail) return undefined;
  const serialized = redactInstallerText(JSON.stringify(detail), secrets);
  return JSON.parse(serialized) as Record<string, unknown>;
}

function emitEvent(
  onEvent: ((event: InstallerEvent) => void) | undefined,
  event: InstallerEvent,
  secrets: string[],
): void {
  onEvent?.({
    ...event,
    message: redactInstallerText(event.message, secrets),
    detail: sanitizeDetail(event.detail, secrets),
  });
}

/** Comandos curtos (up, migrate, exec): cinco minutos bastam. */
const SHORT_DOCKER_TIMEOUT_MS = 300_000;
/**
 * `up --wait` espera a API ficar saudável, e o healthcheck dela dá 180 s de
 * start_period: num Mac acordando do zero cinco minutos ficavam justos.
 */
const STACK_UP_TIMEOUT_MS = 600_000;

async function runDocker(
  deps: Pick<OrchestratorDeps, "run" | "composeFile">,
  docker: DockerInvocation,
  args: string[],
  timeoutMs = SHORT_DOCKER_TIMEOUT_MS,
): Promise<ProcessRunResult> {
  return runDockerCommand(deps.run, docker, args, {
    cwd: path.dirname(deps.composeFile),
    timeoutMs,
  });
}

async function packagedImagesAvailableLocally(
  deps: Pick<OrchestratorDeps, "run">,
  docker: DockerInvocation,
): Promise<boolean> {
  const missing = await missingImagesLocally(deps.run, docker, requiredQuibtImages());
  return missing.length === 0;
}

async function runDatabaseMigrate(
  deps: Pick<OrchestratorDeps, "run" | "composeFile" | "dataDir">,
  docker: DockerInvocation,
): Promise<ProcessRunResult> {
  const envFile = envFilePath(deps.dataDir);
  const base = composeBaseArgs(deps.composeFile, envFile);
  return runDocker(deps, docker, migrateInvocation(base));
}

function composeBaseArgs(composeFile: string, envFile: string): string[] {
  return ["compose", "-f", composeFile, "--env-file", envFile];
}

async function mintPairingInvite(
  apiBase: string,
  bootstrapSecret: string,
  fetchImpl: typeof fetch,
): Promise<{ code: string; token: string; expiresAt: string }> {
  const res = await fetchWithRetry(
    `${apiBase}/api/bootstrap/invites`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-quibt-bootstrap-secret": bootstrapSecret,
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    },
    fetchImpl,
  );
  if (!res.ok) {
    throw new PairingMintHttpError(res.status);
  }
  return (await res.json()) as { code: string; token: string; expiresAt: string };
}

class PairingMintHttpError extends Error {
  constructor(readonly status: number) {
    super(`mint failed with status ${status}`);
  }
}

const CONTAINER_PAIRING_SCRIPT = [
  "const secret = process.env.BOOTSTRAP_SECRET || '';",
  "fetch('http://127.0.0.1:3100/api/bootstrap/invites', { method: 'POST', headers: { 'x-quibt-bootstrap-secret': secret } })",
  ".then(async (res) => { const body = await res.text(); if (!res.ok) { console.error('mint failed with status ' + res.status); process.exit(1); } process.stdout.write(body); })",
  ".catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });",
].join(" ");

async function mintPairingInviteInsideApi(
  deps: Pick<OrchestratorDeps, "run" | "composeFile" | "dataDir">,
  docker: DockerInvocation,
): Promise<{ code: string; token: string; expiresAt: string }> {
  const args = [
    ...composeBaseArgs(deps.composeFile, envFilePath(deps.dataDir)),
    "exec",
    "-T",
    "api",
    "node",
    "-e",
    CONTAINER_PAIRING_SCRIPT,
  ];
  const result = await runDocker(deps, docker, args);
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || "container pairing mint failed",
    );
  }
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  if (
    typeof parsed.code !== "string" ||
    typeof parsed.token !== "string" ||
    typeof parsed.expiresAt !== "string"
  ) {
    throw new Error("container pairing mint returned an invalid response");
  }
  return { code: parsed.code, token: parsed.token, expiresAt: parsed.expiresAt };
}

export {
  deploymentNeedsFirstOwner,
  probeDeploymentNeedsFirstOwner,
} from "./orchestrator-helpers.js";

/**
 * `message` é a frase para quem está na frente da tela; `detail` é o stderr cru (já
 * sem segredos), que vai para os detalhes técnicos e nunca para a linha de status.
 */
function fail(
  emit: (event: InstallerEvent) => void,
  step: InstallStep,
  message: string,
  state: InstallState,
  options: {
    exitCode?: number;
    detail?: string;
    servicesStarted?: boolean;
    dockerMissing?: boolean;
  } = {},
): InstallResult {
  const detail = options.detail?.trim() || undefined;
  emit({ step, status: "failed", message, detail: detail ? { stderr: detail } : undefined });
  return {
    ok: false,
    state,
    error: message,
    errorDetail: detail,
    exitCode: options.exitCode ?? 1,
    servicesStarted: options.servicesStarted,
    dockerMissing: options.dockerMissing,
  };
}

function ensureDockerForStep(
  deps: Pick<OrchestratorDeps, "run" | "platform" | "clock" | "nonInteractive">,
  step: InstallStep,
  emit: (event: InstallerEvent) => void,
  options: { allowDesktopInstall?: DesktopInstallPolicy } = {},
) {
  return ensureDocker({
    run: deps.run,
    platform: deps.platform,
    clock: deps.clock,
    allowDesktopInstall: options.allowDesktopInstall ?? true,
    nonInteractive: deps.nonInteractive,
    onProgress: (message) => emit({ step, status: "running", message }),
  });
}

/**
 * Uma falha de `compose up` traduzida; o stderr cru vai só nos detalhes. A fase entra
 * junto: "denied" aqui é a pasta de dados fora do File sharing, não o ghcr.io.
 */
function composeFailure(
  result: ProcessRunResult,
  fallback: string,
  dataDir: string,
): { message: string; detail: string } {
  const detail = `${result.stderr}\n${result.stdout}`.trim();
  return {
    message: explainDockerFailure(detail, { phase: "up", dataDir }) ?? fallback,
    detail,
  };
}

/** O passo `images` do install: a mesma função que o `update` e a religada usam. */
async function pullImages(
  deps: OrchestratorDeps,
  docker: DockerInvocation,
  envValues: Record<string, string>,
  emit: (event: InstallerEvent) => void,
  step: InstallStep,
): Promise<{ ok: true } | { ok: false; message: string; detail: string }> {
  return pullComposeImages({
    run: deps.run,
    docker,
    clock: deps.clock,
    dataDir: deps.dataDir,
    composeFile: deps.composeFile,
    envFile: envFilePath(deps.dataDir),
    composeMode: deps.composeMode,
    publicAccess: Boolean(envValues[PUBLIC_HOST_ENV]),
    statfs: deps.statfs,
    onProgress: (progress, message) => emit({ step, status: "running", message, progress }),
    onNotice: (message) => emit({ step, status: "running", message }),
  });
}

/**
 * Estado completo = o Quibt já foi instalado aqui; o que falta é ligar. Depois de um
 * reboot os containers ficam parados e o app abria a tela de instalação como se
 * nada existisse. Aqui: confere o Docker (no Mac, abre o Docker Desktop e espera),
 * `compose up --wait`, espera a API e devolve o endereço.
 */
async function startInstalledStack(
  deps: OrchestratorDeps,
  state: InstallState,
  envValues: Record<string, string>,
  secrets: string[],
  emit: (event: InstallerEvent) => void,
  dockerInv: DockerInvocation | undefined,
): Promise<InstallResult> {
  emit({ step: "requirements", status: "running", message: "Conferindo o Docker…" });
  let docker = dockerInv;
  if (!docker) {
    // "start-only": abrir um Docker Desktop já instalado sim; baixar o Docker e pedir a
    // senha do Mac, nunca. Este caminho roda sozinho quando o app abre.
    const ensured = await ensureDockerForStep(deps, "requirements", emit, {
      allowDesktopInstall: "start-only",
    });
    if (!ensured.ok) {
      const gone = ensured.reason === "desktop-missing";
      return fail(
        emit,
        "requirements",
        gone ? DOCKER_DESKTOP_GONE_MESSAGE : ensured.message,
        state,
        {
          dockerMissing: gone,
        },
      );
    }
    docker = ensured.invocation;
  }
  emit({ step: "requirements", status: "succeeded", message: "Docker no ar" });

  const envFile = envFilePath(deps.dataDir);
  // As imagens somem sozinhas (um "Clean / Purge data" no Docker Desktop, um
  // `docker system prune -a`): sem isto o `up --wait` baixava 1,7 GB em silêncio, sob um
  // teto de dez minutos, atrás de uma tela que promete "cerca de um minuto".
  if (deps.composeMode === "packaged" && !(await packagedImagesAvailableLocally(deps, docker))) {
    emit({ step: "images", status: "running", message: "Conferindo as imagens do Quibt Bot…" });
    const pulled = await pullImages(deps, docker, envValues, emit, "images");
    if (!pulled.ok) {
      return fail(emit, "images", pulled.message, state, {
        detail: redactInstallerText(pulled.detail, secrets),
      });
    }
    emit({ step: "images", status: "succeeded", message: "Imagens prontas" });
  }

  emit({ step: "services", status: "running", message: "Ligando o Quibt Bot…" });
  const up = await runDocker(
    deps,
    docker,
    stackUpInvocation(deps.composeMode, deps.composeFile, envFile, {
      publicAccess: Boolean(envValues[PUBLIC_HOST_ENV]),
    }),
    STACK_UP_TIMEOUT_MS,
  );
  if (up.code !== 0) {
    const failure = composeFailure(
      up,
      "Não consegui ligar os serviços do Quibt Bot. Veja os detalhes técnicos e tente de novo.",
      deps.dataDir,
    );
    return fail(emit, "services", failure.message, state, {
      detail: redactInstallerText(failure.detail, secrets),
    });
  }
  emit({ step: "services", status: "succeeded", message: "Serviços no ar" });

  emit({ step: "health", status: "running", message: "Esperando a API responder…" });
  const readyUrl = apiReadyUrl(envValues, deps.publicUrl);
  const healthy = await waitForReady(readyUrl, deps.fetch, deps.clock);
  if (!healthy) {
    return fail(
      emit,
      "health",
      `Os serviços subiram, mas a API ainda não respondeu em ${readyUrl}. Espere um minuto e tente de novo.`,
      state,
      { servicesStarted: true },
    );
  }
  const url = reachableUrl(envValues, deps.publicUrl);
  emit({ step: "health", status: "succeeded", message: `No ar em ${url}` });
  return { ok: true, state, alreadyInstalled: true, url, servicesStarted: true };
}

function runningStepMessage(step: InstallStep): string {
  switch (step) {
    case "requirements":
      return "Preparando o Docker automaticamente…";
    case "environment":
      return "Gerando a configuração local…";
    case "images":
      return "Preparando as imagens do Quibt Bot…";
    case "services":
      return "Subindo os serviços do Quibt Bot…";
    case "database":
      return "Aplicando as migrações do banco…";
    case "health":
      return "Verificando se a API está saudável…";
    case "pairing":
      return "Preparando o pareamento…";
  }
}

export async function finalizePairingInstall(
  dataDir: string,
  clock: Clock,
  onWarning?: (message: string) => void,
  alive?: (pid: number) => boolean,
): Promise<InstallState> {
  const lock = acquireInstallLock(dataDir, process.pid, clock.now(), alive);
  if (!lock.ok) {
    throw new Error(lock.message);
  }

  try {
    const state =
      loadInstallState(dataDir, onWarning) ?? initialInstallState(INSTALL_RELEASE, clock.now());
    const next = completeInstallStep(state, "pairing", clock.now());
    saveInstallState(dataDir, next);
    return next;
  } finally {
    releaseInstallLock(dataDir);
  }
}

export async function runInstall(deps: OrchestratorDeps): Promise<InstallResult> {
  const lock = acquireInstallLock(deps.dataDir, process.pid, deps.clock.now());
  if (!lock.ok) {
    // Antes de qualquer segredo existir em memória: pode emitir direto.
    const message = explainInstallLock(lock.message);
    deps.onEvent?.({
      step: "requirements",
      status: "failed",
      message,
      detail: { lock: lock.message },
    });
    return {
      ok: false,
      state: initialInstallState(INSTALL_RELEASE, deps.clock.now()),
      error: message,
      errorDetail: lock.message,
      exitCode: 1,
    };
  }

  let state = initialInstallState(INSTALL_RELEASE, deps.clock.now());
  const secrets: string[] = [];
  let emit: (event: InstallerEvent) => void = () => undefined;
  let dockerInv = deps.docker;
  let servicesStarted = false;

  try {
    const inspected = inspectInstallState(deps.dataDir);
    if (!inspected.ok) {
      if (inspected.reason === "update_required") {
        const message = explainUpdateRequired(inspected.release, INSTALL_RELEASE);
        deps.onEvent?.({
          step: "requirements",
          status: "failed",
          message,
          detail: { installedRelease: inspected.release, installerRelease: INSTALL_RELEASE },
        });
        return {
          ok: false,
          state: initialInstallState(INSTALL_RELEASE, deps.clock.now()),
          error: message,
          errorDetail: inspected.message,
          exitCode: 2,
        };
      }
      deps.onWarning?.(inspected.message);
    }

    state = loadInstallState(deps.dataDir, deps.onWarning) ?? state;
    let envValues = loadEnvValues(deps.dataDir);
    let access: PublicAccessDecision | undefined;
    secrets.push(...collectSecrets(envValues));
    emit = (event: InstallerEvent) => emitEvent(deps.onEvent, event, secrets);

    if (isInstallStateComplete(state)) {
      return await startInstalledStack(deps, state, envValues, secrets, emit, dockerInv);
    }

    while (true) {
      const step = nextInstallStep(state);
      if (!step) break;

      emit({ step, status: "running", message: runningStepMessage(step) });

      if (step === "requirements") {
        if (!dockerInv) {
          const docker = await ensureDockerForStep(deps, step, emit);
          if (!docker.ok) return fail(emit, step, docker.message, state);
          dockerInv = docker.invocation;
        }
      }

      if (step === "environment") {
        // Decidido AQUI, antes do env existir: o host público entra nas origens do
        // Better Auth e do web, e mudar isso depois invalidaria sessões. Um host já
        // gravado por uma instalação anterior vence a descoberta, para o certificado
        // e o endereço que o celular guardou continuarem valendo.
        // A descoberta de IP só acontece quando quem chama a pede (`publicAccess`): o
        // CLI passa a rede de verdade; `pnpm dev` e os testes não passam nada e ficam
        // locais. Assim a suíte nunca depende da internet, por construção.
        access = deps.publicAccess
          ? await decidePublicAccess({
              forceLocal: deps.forceLocal,
              existingHost: readExistingPublicHost(deps.dataDir),
              ...deps.publicAccess,
            })
          : { mode: "local", reason: "Instalação a partir do código fica na rede local." };
        const env = ensureInstallEnvironment(deps.dataDir, deps.publicUrl, {
          publicHost: access.mode === "public" ? access.host : undefined,
        });
        envValues = env.values;
        secrets.length = 0;
        secrets.push(...collectSecrets(envValues));
        emit({
          step,
          status: "running",
          message:
            access.mode === "public"
              ? `Endereço público: ${access.url} (HTTPS pelo Let's Encrypt, sem domínio)`
              : access.reason,
        });
      }

      if (step === "images") {
        if (!dockerInv) {
          const docker = await ensureDockerForStep(deps, step, emit);
          if (!docker.ok) return fail(emit, step, docker.message, state);
          dockerInv = docker.invocation;
        }
        const useLocalImages =
          deps.composeMode === "packaged" &&
          (await packagedImagesAvailableLocally(deps, dockerInv));
        if (useLocalImages) {
          emit({
            step,
            status: "running",
            message: "As imagens verificadas já estão neste computador; nada para baixar.",
          });
        } else {
          const pulled = await pullImages(deps, dockerInv, envValues, emit, step);
          if (!pulled.ok) {
            return fail(emit, step, pulled.message, state, {
              detail: redactInstallerText(pulled.detail, secrets),
            });
          }
        }
      }

      if (step === "services") {
        if (!dockerInv) {
          const docker = await ensureDockerForStep(deps, step, emit);
          if (!docker.ok) return fail(emit, step, docker.message, state);
          dockerInv = docker.invocation;
        }
        const envFile = envFilePath(deps.dataDir);
        const upArgs =
          deps.composeMode === "packaged"
            ? postgresUpInvocation(deps.composeMode, deps.composeFile, envFile)
            : composeInvocation(deps.composeMode, deps.composeFile, envFile, "up");
        const up = await runDocker(deps, dockerInv, upArgs, STACK_UP_TIMEOUT_MS);
        servicesStarted = true;
        if (up.code !== 0) {
          const failure = composeFailure(up, "Os serviços do Quibt Bot não subiram.", deps.dataDir);
          return fail(emit, step, failure.message, state, {
            detail: redactInstallerText(failure.detail, secrets),
            servicesStarted,
          });
        }
      }

      if (step === "database") {
        if (!dockerInv) {
          const docker = await ensureDockerForStep(deps, step, emit);
          if (!docker.ok) return fail(emit, step, docker.message, state);
          dockerInv = docker.invocation;
        }
        const envFile = envFilePath(deps.dataDir);
        const migrate = await runDatabaseMigrate(deps, dockerInv);
        if (migrate.code !== 0) {
          return fail(
            emit,
            step,
            redactInstallerText(migrationFailureMessage(migrate.stderr || migrate.stdout), secrets),
            state,
            { servicesStarted },
          );
        }
        if (deps.composeMode === "packaged") {
          const appsUp = await runDocker(
            deps,
            dockerInv,
            appServicesUpInvocation(deps.composeMode, deps.composeFile, envFile, {
              publicAccess: access?.mode === "public" || Boolean(envValues[PUBLIC_HOST_ENV]),
            }),
            STACK_UP_TIMEOUT_MS,
          );
          servicesStarted = true;
          if (appsUp.code !== 0) {
            const failure = composeFailure(
              appsUp,
              "Os serviços do Quibt Bot não subiram.",
              deps.dataDir,
            );
            return fail(emit, step, failure.message, state, {
              detail: redactInstallerText(failure.detail, secrets),
              servicesStarted,
            });
          }
        }
      }

      if (step === "health") {
        const readyUrl = apiReadyUrl(envValues, deps.publicUrl);
        const healthy = await waitForReady(readyUrl, deps.fetch, deps.clock);
        if (!healthy) {
          return fail(
            emit,
            step,
            `A API não respondeu em ${readyUrl}. Espere um minuto e tente de novo.`,
            state,
            { servicesStarted },
          );
        }
      }

      if (step === "pairing") {
        const apiBase = apiBaseUrl(envValues, deps.publicUrl);
        const ownerProbe = await probeDeploymentNeedsFirstOwner(apiBase, deps.fetch);
        if (!ownerProbe.ok) {
          return fail(emit, step, ownerProbe.error, state);
        }
        if (!ownerProbe.needsFirstOwner) {
          state = completeInstallStep(state, step, deps.clock.now());
          saveInstallState(deps.dataDir, state);
          emit({ step, status: "succeeded", message: "Deployment already claimed" });
          return {
            ok: true,
            state,
            claimedInstruction: CLAIMED_PAIRING_INSTRUCTION,
            url: reachableUrl(envValues, deps.publicUrl),
            servicesStarted,
          };
        }

        const bootstrapSecret = envValues.BOOTSTRAP_SECRET;
        if (!bootstrapSecret) {
          return fail(emit, step, "BOOTSTRAP_SECRET missing from install environment", state);
        }

        let minted: { code: string; token: string; expiresAt: string };
        try {
          minted = await mintPairingInvite(apiBase, bootstrapSecret, deps.fetch);
        } catch (error) {
          if (
            deps.composeMode !== "packaged" ||
            !(error instanceof PairingMintHttpError) ||
            error.status !== 404
          ) {
            throw error;
          }
          if (!dockerInv) {
            const docker = await ensureDockerForStep(deps, step, emit);
            if (!docker.ok) return fail(emit, step, docker.message, state);
            dockerInv = docker.invocation;
          }
          minted = await mintPairingInviteInsideApi(deps, dockerInv);
        }
        // The installer talks directly to the loopback-only API. Phones and remote
        // browsers must use the public web origin, whose /api proxy reaches that API.
        const reach = reachableUrl(envValues, deps.publicUrl);
        const pairing = buildPairingOutput(reach, reach, minted);
        emit({ step, status: "succeeded", message: "Pairing invite ready" });
        return { ok: true, state, pairing, pairingPending: true, url: reach, servicesStarted };
      }

      state = completeInstallStep(state, step, deps.clock.now());
      saveInstallState(deps.dataDir, state);
      emit({ step, status: "succeeded", message: `${step} complete` });
    }

    return { ok: true, state, url: reachableUrl(envValues, deps.publicUrl), servicesStarted };
  } catch (error) {
    const message = redactInstallerText(
      error instanceof Error ? error.message : "install step failed",
      secrets,
    );
    const step = nextInstallStep(state) ?? "health";
    return fail(emit, step, message, state, { servicesStarted });
  } finally {
    releaseInstallLock(deps.dataDir);
  }
}

export interface StatusResult {
  state: InstallState | null;
  services: unknown[];
  healthy: boolean;
  release: string;
  url: string;
  stateIssue?: { reason: "update_required" | "corrupt"; message: string };
}

export async function runStatus(deps: {
  dataDir: string;
  publicUrl: string;
  composeFile: string;
  run: ProcessRunner;
  fetch: typeof fetch;
  docker?: DockerInvocation;
}): Promise<StatusResult> {
  const inspected = inspectInstallState(deps.dataDir);
  const state = inspected.ok
    ? inspected.state
    : inspected.reason === "update_required"
      ? null
      : null;
  const envValues = loadEnvValues(deps.dataDir);
  const envRelease = envValues.QUIBT_STACK_VERSION;
  const stateIssue = !inspected.ok
    ? { reason: inspected.reason, message: inspected.message }
    : envRelease && envRelease !== INSTALL_RELEASE
      ? {
          reason: "update_required" as const,
          message: `Environment release ${envRelease} does not match embedded installer release ${INSTALL_RELEASE}.`,
        }
      : undefined;
  const envFile = envFilePath(deps.dataDir);
  const base = composeInvocation("packaged", deps.composeFile, envFile, "up").slice(0, -3);
  const dockerInv = deps.docker ??
    (await resolveDockerInvocation(deps.run)) ?? { command: "docker", prefixArgs: [] };
  const ps = await runDockerCommand(deps.run, dockerInv, [...base, "ps", "--format", "json"]);
  let services: unknown[] = [];
  if (ps.code === 0 && ps.stdout.trim()) {
    services = parseComposePsOutput(ps.stdout).rows;
  }
  const readyUrl = apiReadyUrl(envValues, deps.publicUrl);
  let healthy = false;
  try {
    const res = await fetchWithRetry(
      readyUrl,
      {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      },
      deps.fetch,
    );
    healthy = res.ok;
  } catch {
    healthy = false;
  }
  return {
    state,
    services,
    healthy,
    release: INSTALL_RELEASE,
    url: reachableUrl(envValues, deps.publicUrl),
    stateIssue,
  };
}

export async function runPair(deps: {
  dataDir: string;
  publicUrl: string;
  fetch: typeof fetch;
  run?: ProcessRunner;
  composeFile?: string;
  composeMode?: ComposeMode;
  docker?: DockerInvocation;
}): Promise<{ ok: true; pairing: SensitivePairingOutput } | { ok: false; message: string }> {
  const envValues = loadEnvValues(deps.dataDir);
  const apiBase = apiBaseUrl(envValues, deps.publicUrl);
  const ownerProbe = await probeDeploymentNeedsFirstOwner(apiBase, deps.fetch);
  if (!ownerProbe.ok) {
    return { ok: false, message: ownerProbe.error };
  }
  if (!ownerProbe.needsFirstOwner) {
    return { ok: false, message: CLAIMED_PAIRING_INSTRUCTION };
  }
  const bootstrapSecret = envValues.BOOTSTRAP_SECRET;
  if (!bootstrapSecret) {
    return { ok: false, message: "Install incomplete: BOOTSTRAP_SECRET is missing." };
  }
  let minted: { code: string; token: string; expiresAt: string };
  try {
    minted = await mintPairingInvite(apiBase, bootstrapSecret, deps.fetch);
  } catch (error) {
    if (
      deps.composeMode !== "packaged" ||
      !deps.run ||
      !deps.composeFile ||
      !(error instanceof PairingMintHttpError) ||
      error.status !== 404
    ) {
      throw error;
    }
    const docker = deps.docker ?? (await resolveDockerInvocation(deps.run));
    if (!docker) {
      return { ok: false, message: "Docker is unavailable for local owner pairing." };
    }
    minted = await mintPairingInviteInsideApi(
      {
        dataDir: deps.dataDir,
        composeFile: deps.composeFile,
        run: deps.run,
      },
      docker,
    );
  }
  return {
    ok: true,
    pairing: buildPairingOutput(
      reachableUrl(envValues, deps.publicUrl),
      reachableUrl(envValues, deps.publicUrl),
      minted,
    ),
  };
}

export type { SensitivePairingOutput } from "./pairing.js";
export { runUpdate, type UpdateResult } from "./update.js";
