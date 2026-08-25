import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Clock, ProcessRunner } from "./orchestrator.js";
import { resolveComposeFile } from "./paths.js";

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
  composeInvocation,
  DESKTOP_SIGNING,
  type DesktopSigning,
  INSTALL_RELEASE,
  postgresUpInvocation,
  resolveQuibtImage,
} from "./compose.js";
export { assessComposeServices, REQUIRED_COMPOSE_SERVICES } from "./compose-services.js";
export {
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

export function defaultDataDir(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "Quibt");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Quibt");
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
        const finish = (result: {
          code: number;
          stdout: string;
          stderr: string;
          stdoutBytes?: Buffer;
        }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          finish({
            code: 124,
            stdout: Buffer.concat(chunks).toString("utf8"),
            stderr: "process timed out",
          });
        }, options?.timeoutMs ?? timeoutMs);
        child.stdout.on("data", (chunk) => chunks.push(chunk as Buffer));
        child.stderr.on("data", (chunk) => errChunks.push(chunk as Buffer));
        child.on("error", (error) => {
          finish({ code: 1, stdout: "", stderr: error.message });
        });
        child.on("close", (code) => {
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
