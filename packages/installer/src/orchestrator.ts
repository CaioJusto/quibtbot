import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  appServicesUpInvocation,
  type ComposeMode,
  composeInvocation,
  INSTALL_RELEASE,
  postgresUpInvocation,
  requiredQuibtImages,
} from "./compose.js";
import { parseComposePsOutput } from "./compose-ps.js";
import type { DockerInvocation } from "./docker-invocation.js";
import { resolveDockerInvocation, runDockerCommand } from "./docker-invocation.js";
import { ensureDocker } from "./docker-requirements.js";
import { ensureInstallEnvironment, parseEnvFile } from "./environment.js";
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
import { redactInstallerText } from "./redact.js";
import { type InstallState, type InstallStep, nextInstallStep } from "./state.js";
import {
  completeInstallStep,
  initialInstallState,
  inspectInstallState,
  loadInstallState,
  saveInstallState,
} from "./state-persist.js";

export type InstallerEventStatus = "running" | "succeeded" | "failed";

export interface InstallerEvent {
  step: InstallStep;
  status: InstallerEventStatus;
  message: string;
  detail?: Record<string, unknown>;
}

export interface ProcessRunResult {
  code: number;
  stdout: string;
  stderr: string;
  stdoutBytes?: Buffer;
}

export interface ProcessRunner {
  run(
    command: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<ProcessRunResult>;
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
  exitCode?: number;
}

export interface OrchestratorDeps {
  dataDir: string;
  publicUrl: string;
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

async function runDocker(
  deps: Pick<OrchestratorDeps, "run" | "composeFile">,
  docker: DockerInvocation,
  args: string[],
): Promise<ProcessRunResult> {
  return runDockerCommand(deps.run, docker, args, {
    cwd: path.dirname(deps.composeFile),
    timeoutMs: 300_000,
  });
}

async function runComposeStep(
  deps: Pick<OrchestratorDeps, "run" | "composeFile" | "dataDir" | "composeMode">,
  docker: DockerInvocation,
  step: "pull" | "up",
): Promise<ProcessRunResult> {
  const envFile = envFilePath(deps.dataDir);
  const args = composeInvocation(deps.composeMode, deps.composeFile, envFile, step);
  return runDocker(deps, docker, args);
}

async function packagedImagesAvailableLocally(
  deps: Pick<OrchestratorDeps, "run">,
  docker: DockerInvocation,
): Promise<boolean> {
  for (const reference of requiredQuibtImages()) {
    const inspected = await runDockerCommand(
      deps.run,
      docker,
      ["image", "inspect", "-f", "{{.Id}}", reference],
      { timeoutMs: 30_000 },
    );
    if (inspected.code !== 0 || !inspected.stdout.trim()) return false;
  }
  return true;
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

function fail(
  emit: (event: InstallerEvent) => void,
  step: InstallStep,
  message: string,
  state: InstallState,
  exitCode = 1,
): InstallResult {
  emit({ step, status: "failed", message });
  return { ok: false, state, error: message, exitCode };
}

function ensureDockerForStep(
  deps: Pick<OrchestratorDeps, "run" | "platform" | "clock">,
  step: InstallStep,
  emit: (event: InstallerEvent) => void,
) {
  return ensureDocker({
    run: deps.run,
    platform: deps.platform,
    clock: deps.clock,
    allowDesktopInstall: true,
    onProgress: (message) => emit({ step, status: "running", message }),
  });
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
    return {
      ok: false,
      state: initialInstallState(INSTALL_RELEASE, deps.clock.now()),
      error: lock.message,
      exitCode: 1,
    };
  }

  let state = initialInstallState(INSTALL_RELEASE, deps.clock.now());
  const secrets: string[] = [];
  let emit: (event: InstallerEvent) => void = () => undefined;
  let dockerInv = deps.docker;

  try {
    const inspected = inspectInstallState(deps.dataDir);
    if (!inspected.ok) {
      if (inspected.reason === "update_required") {
        return {
          ok: false,
          state: initialInstallState(INSTALL_RELEASE, deps.clock.now()),
          error: inspected.message,
          exitCode: 2,
        };
      }
      deps.onWarning?.(inspected.message);
    }

    state = loadInstallState(deps.dataDir, deps.onWarning) ?? state;
    let envValues = loadEnvValues(deps.dataDir);
    secrets.push(...collectSecrets(envValues));
    emit = (event: InstallerEvent) => emitEvent(deps.onEvent, event, secrets);
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
        const env = ensureInstallEnvironment(deps.dataDir, deps.publicUrl);
        envValues = env.values;
        secrets.length = 0;
        secrets.push(...collectSecrets(envValues));
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
            message: "Using verified images already available on this computer",
          });
        } else {
          const pull = await runComposeStep(deps, dockerInv, "pull");
          if (pull.code !== 0) {
            return fail(
              emit,
              step,
              redactInstallerText(pull.stderr || pull.stdout || "image pull failed", secrets),
              state,
            );
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
        const up = await runDocker(deps, dockerInv, upArgs);
        if (up.code !== 0) {
          return fail(
            emit,
            step,
            redactInstallerText(up.stderr || up.stdout || "services failed", secrets),
            state,
          );
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
          );
        }
        if (deps.composeMode === "packaged") {
          const appsUp = await runDocker(
            deps,
            dockerInv,
            appServicesUpInvocation(deps.composeMode, deps.composeFile, envFile),
          );
          if (appsUp.code !== 0) {
            return fail(
              emit,
              step,
              redactInstallerText(appsUp.stderr || appsUp.stdout || "app services failed", secrets),
              state,
            );
          }
        }
      }

      if (step === "health") {
        const readyUrl = apiReadyUrl(envValues, deps.publicUrl);
        const healthy = await waitForReady(readyUrl, deps.fetch, deps.clock);
        if (!healthy) return fail(emit, step, `API not ready at ${readyUrl}`, state);
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
          return { ok: true, state, claimedInstruction: CLAIMED_PAIRING_INSTRUCTION };
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
        const pairing = buildPairingOutput(deps.publicUrl, deps.publicUrl, minted);
        emit({ step, status: "succeeded", message: "Pairing invite ready" });
        return { ok: true, state, pairing, pairingPending: true };
      }

      state = completeInstallStep(state, step, deps.clock.now());
      saveInstallState(deps.dataDir, state);
      emit({ step, status: "succeeded", message: `${step} complete` });
    }

    return { ok: true, state };
  } catch (error) {
    const message = redactInstallerText(
      error instanceof Error ? error.message : "install step failed",
      secrets,
    );
    const step = nextInstallStep(state) ?? "health";
    return fail(emit, step, message, state);
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
    url: deps.publicUrl,
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
    pairing: buildPairingOutput(deps.publicUrl, deps.publicUrl, minted),
  };
}

export type { SensitivePairingOutput } from "./pairing.js";
export { runUpdate, type UpdateResult } from "./update.js";
