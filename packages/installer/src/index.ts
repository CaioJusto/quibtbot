import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Clock, ProcessRunner, ProcessRunResult } from "./orchestrator.js";
import { resolveComposeFile } from "./paths.js";

export {
  BOX_INSTALL_MISSING_EXIT_CODE,
  BOX_PUBLIC_PROXY_ENV,
  BOX_WEB_PORT,
  buildBoxHostCommand,
  buildBoxHostingPreparationShell,
  buildBoxPublicConfigurationShell,
  normalizeBoxHostedUrl,
  type ProbeBoxHostedUrlOptions,
  parseBoxHostedUrl,
  probeBoxHostedUrl,
} from "@quibt/core";

export {
  decodeProcessStdoutBytes,
  isValidPgCustomDump,
  isValidPostgresDump,
  PG_CUSTOM_DUMP_MAGIC,
  validateBackupBundle,
  writeBackupBundle,
} from "./backup.js";
export {
  allQuibtImages,
  appServicesUpInvocation,
  type ComposeMode,
  type ComposeStep,
  composeImagesInvocation,
  composeInvocation,
  DESKTOP_SIGNING,
  type DesktopSigning,
  INSTALL_RELEASE,
  postgresUpInvocation,
  resolveQuibtImage,
  stackUpInvocation,
} from "./compose.js";
export { assessComposeServices, REQUIRED_COMPOSE_SERVICES } from "./compose-services.js";
export {
  type DesktopInstallPolicy,
  type DockerFailureReason,
  type DockerInvocation,
  dockerArgv,
  type EnsureDockerResult,
  ensureDocker,
  resolveDockerInvocation,
  runDockerCommand,
} from "./docker-requirements.js";
export {
  type DoctorCheck,
  type DoctorReport,
  defaultCheckPort,
  probeQuibtServicePort,
  runDoctor,
} from "./doctor.js";
export {
  ensureInstallEnvironment,
  type InstallEnvironmentResult,
  parseEnvFile,
} from "./environment.js";
export {
  DOCKER_DESKTOP_GONE_MESSAGE,
  type DockerFailureContext,
  type DockerFailurePhase,
  explainDockerFailure,
  explainInstallLock,
  explainUpdateRequired,
} from "./failure-messages.js";
export {
  checkDiskSpace,
  DOWNLOAD_NOTICE,
  downloadNotice,
  formatElapsed,
  formatGigabytes,
  missingImagesLocally,
  NOTHING_TO_DOWNLOAD_NOTICE,
  PULL_ATTEMPTS,
  PULL_HEARTBEAT_INTERVAL_MS,
  PULL_INACTIVITY_TIMEOUT_MS,
  PullLayerTracker,
  type PullProgress,
  progressMessage,
  quietProgressMessage,
  REQUIRED_FREE_BYTES,
  requiredFreeBytesFor,
  shortImageName,
} from "./image-pull.js";
export {
  acquireInstallLock,
  installLockPath,
  readInstallLock,
  releaseInstallLock,
  touchLockDirMtime,
} from "./install-lock.js";
export {
  CONTAINER_MIGRATE_ARGS,
  MIGRATION_ENTRYPOINT_MISSING_MESSAGE,
  migrateInvocation,
  migrationFailureMessage,
} from "./migrate.js";
export {
  type Clock,
  deploymentNeedsFirstOwner,
  finalizePairingInstall,
  type InstallerEvent,
  type InstallerEventStatus,
  type InstallResult,
  type OrchestratorDeps,
  type ProcessRunner,
  type ProcessRunOptions,
  type ProcessRunResult,
  probeDeploymentNeedsFirstOwner,
  runInstall,
  runPair,
  runStatus,
  type SensitivePairingOutput,
  type StatusResult,
} from "./orchestrator.js";
export type { DeploymentOwnerProbe } from "./orchestrator-helpers.js";
export { apiReadyUrl, CLAIMED_PAIRING_INSTRUCTION } from "./orchestrator-helpers.js";
export {
  canRevealPairingSecrets,
  PAIRING_OUTPUT_REFUSED_MESSAGE,
} from "./pairing-output.js";
export { COMPOSE_MANIFEST_NAME, resolveComposeFile } from "./paths.js";
export { diagnoseDataDirectory, diagnoseEnvFilePermissions } from "./permissions.js";
export { processExists } from "./process-exists.js";
export { type PullStepDeps, type PullStepOutcome, pullComposeImages } from "./pull-step.js";
export { redactInstallerText } from "./redact.js";
export {
  embeddedRelease,
  resolvePreviousRelease,
  resolveUpdateTarget,
} from "./release-allowlist.js";
export { assertSupportedRelease, parseStrictSemver } from "./semver.js";
export {
  INSTALL_STEPS,
  type InstallState,
  type InstallStep,
  nextInstallStep,
} from "./state.js";
export {
  classifyInstallState,
  classifyInstallStateForInstall,
  classifyInstallStateForUpdate,
  classifyInstallStateReadOnly,
  completeInstallStep,
  type InstallStateValidation,
  initialInstallState,
  inspectInstallState,
  inspectInstallStateStructure,
  installStatePath,
  isEmbeddedTrustedRelease,
  isInstallStateComplete,
  loadInstallState,
  loadInstallStateForUpdate,
  saveInstallState,
  validateInstallState,
} from "./state-persist.js";
export {
  runUninstall,
  type UninstallDeps,
  type UninstallEvent,
  type UninstallOptions,
  type UninstallResult,
  type UninstallStep,
} from "./uninstall.js";
export {
  captureLocalImages,
  type RollbackRecovery,
  restoreRollback,
  runUpdate,
  type UpdateResult,
} from "./update.js";

const DEFAULT_PROCESS_TIMEOUT_MS = 300_000;

export function resolveDarwinDataDir(
  homeDir = os.homedir(),
  pathExists: (target: string) => boolean = existsSync,
): string {
  const applicationSupport = path.join(homeDir, "Library", "Application Support");
  const desktopDir = path.join(applicationSupport, "Quibt Bot");
  const legacyCliDir = path.join(applicationSupport, "Quibt");
  const hasInstall = (dir: string) =>
    pathExists(path.join(dir, "install-state.json")) || pathExists(path.join(dir, "quibt.env"));

  // Electron uses "Quibt Bot" as its macOS userData directory. Prefer that install so the
  // CLI can update a stack created by the desktop app; retain a pre-existing legacy CLI install.
  if (hasInstall(desktopDir)) return desktopDir;
  if (hasInstall(legacyCliDir)) return legacyCliDir;
  return desktopDir;
}

export function defaultDataDir(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "Quibt");
  }
  if (process.platform === "darwin") {
    return resolveDarwinDataDir();
  }
  const base = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, "quibt");
}

export function defaultComposeFile(
  exePath = process.argv[1] ?? fileURLToPath(import.meta.url),
): string {
  const resolved = resolveComposeFile(exePath);
  if (!resolved.ok) {
    throw new Error(resolved.message);
  }
  return resolved.path;
}

export function defaultPublicUrl(): string {
  return "http://127.0.0.1:5173";
}

/**
 * Entrega linhas completas a `onOutput` conforme chegam. O `docker pull` sem TTY
 * imprime uma linha por camada; é isso que vira a barra de progresso.
 */
class LineSplitter {
  private pending = "";

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer): void {
    this.pending += chunk.toString("utf8");
    let newline = this.pending.indexOf("\n");
    while (newline >= 0) {
      this.onLine(this.pending.slice(0, newline).replace(/\r$/, ""));
      this.pending = this.pending.slice(newline + 1);
      newline = this.pending.indexOf("\n");
    }
  }

  flush(): void {
    if (this.pending) this.onLine(this.pending);
    this.pending = "";
  }
}

export function createProcessRunner(timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS): ProcessRunner {
  return {
    run(command, args, options) {
      return new Promise((resolve) => {
        const child = spawn(command, args, {
          cwd: options?.cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        let settled = false;
        let idleTimer: NodeJS.Timeout | null = null;
        const absoluteTimeoutMs = options?.timeoutMs ?? timeoutMs;
        const absoluteDeadline = Date.now() + absoluteTimeoutMs;
        const finish = (result: ProcessRunResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (idleTimer) clearTimeout(idleTimer);
          resolve(result);
        };
        const killForTimeout = (timedOut: "absolute" | "inactivity") => {
          // Under heavy load both timers can become runnable before Node gets the event loop
          // back. Once the absolute deadline has elapsed it is the authoritative reason,
          // regardless of which timer callback happened to execute first.
          const timeoutKind =
            timedOut === "inactivity" && Date.now() >= absoluteDeadline ? "absolute" : timedOut;
          child.kill("SIGTERM");
          finish({
            code: 124,
            stdout: Buffer.concat(chunks).toString("utf8"),
            stderr:
              timeoutKind === "inactivity"
                ? `process produced no output for ${Math.round((options?.inactivityTimeoutMs ?? 0) / 1000)} s`
                : "process timed out",
            timedOut: timeoutKind,
          });
        };
        const timer = setTimeout(() => killForTimeout("absolute"), absoluteTimeoutMs);
        const armIdleTimer = () => {
          const idleMs = options?.inactivityTimeoutMs;
          if (!idleMs) return;
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => killForTimeout("inactivity"), idleMs);
        };
        armIdleTimer();
        const onOutput = options?.onOutput;
        const stdoutLines = onOutput ? new LineSplitter((line) => onOutput(line, "stdout")) : null;
        const stderrLines = onOutput ? new LineSplitter((line) => onOutput(line, "stderr")) : null;
        child.stdout.on("data", (chunk) => {
          chunks.push(chunk as Buffer);
          armIdleTimer();
          stdoutLines?.push(chunk as Buffer);
        });
        child.stderr.on("data", (chunk) => {
          errChunks.push(chunk as Buffer);
          armIdleTimer();
          stderrLines?.push(chunk as Buffer);
        });
        child.on("error", (error) => {
          finish({ code: 1, stdout: "", stderr: error.message });
        });
        child.on("close", (code) => {
          stdoutLines?.flush();
          stderrLines?.flush();
          const stdoutBuffer = Buffer.concat(chunks);
          finish({
            code: code ?? 1,
            stdout: stdoutBuffer.toString("latin1"),
            stderr: Buffer.concat(errChunks).toString("utf8"),
            stdoutBytes: stdoutBuffer,
          });
        });
      });
    },
  };
}

export function createClock(): Clock {
  return {
    now: () => new Date(),
    async sleep(ms) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}
