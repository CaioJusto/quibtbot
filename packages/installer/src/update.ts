import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  type BackupBundle,
  decodeProcessStdoutBytes,
  writeAtomicFile,
  writeBackupBundle,
} from "./backup.js";
import {
  appServicesUpInvocation,
  composeInvocation,
  INSTALL_RELEASE,
  postgresUpInvocation,
} from "./compose.js";
import type { DockerInvocation } from "./docker-invocation.js";
import { runDockerCommand } from "./docker-invocation.js";
import { ensureDocker } from "./docker-requirements.js";
import { parseEnvFile } from "./environment.js";
import { acquireInstallLock, releaseInstallLock } from "./install-lock.js";
import { migrateInvocation, migrationFailureMessage } from "./migrate.js";
import type { Clock, InstallerEvent, ProcessRunner } from "./orchestrator.js";
import { apiReadyUrl, waitForReady } from "./orchestrator-helpers.js";
import { redactInstallerText } from "./redact.js";
import { resolvePreviousRelease, resolveUpdateTarget } from "./release-allowlist.js";
import {
  captureLocalImages,
  performCompleteRollback,
  type RollbackMetadata,
  type RollbackRecovery,
  requiredImageCount,
} from "./rollback.js";
import {
  initialInstallState,
  loadInstallStateForUpdate,
  saveInstallState,
} from "./state-persist.js";

export type { ImageRollbackRef, RollbackMetadata, RollbackRecovery } from "./rollback.js";
export { captureLocalImages, performCompleteRollback, requiredImageCount } from "./rollback.js";

export interface UpdateResult {
  ok: boolean;
  release: string;
  previousRelease?: string;
  backupPath?: string;
  recovery?: RollbackRecovery;
  error?: string;
}

export interface UpdateDeps {
  dataDir: string;
  composeFile: string;
  targetRelease?: string;
  run: ProcessRunner;
  fetch: typeof fetch;
  clock: Clock;
  docker?: DockerInvocation;
  onEvent?: (event: InstallerEvent) => void;
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

function emitEvent(
  onEvent: ((event: InstallerEvent) => void) | undefined,
  event: InstallerEvent,
  secrets: string[],
): void {
  onEvent?.({
    ...event,
    message: redactInstallerText(event.message, secrets),
    detail: event.detail
      ? (JSON.parse(redactInstallerText(JSON.stringify(event.detail), secrets)) as Record<
          string,
          unknown
        >)
      : undefined,
  });
}

function composeBaseArgs(composeFile: string, envFile: string): string[] {
  return ["compose", "-f", composeFile, "--env-file", envFile];
}

function updateEnvRelease(envBody: string, release: string): string {
  if (/^QUIBT_STACK_VERSION=/m.test(envBody)) {
    return envBody.replace(/^QUIBT_STACK_VERSION=.*$/m, `QUIBT_STACK_VERSION=${release}`);
  }
  return `${envBody.trimEnd()}\nQUIBT_STACK_VERSION=${release}\n`;
}

export async function restoreRollback(
  deps: Pick<UpdateDeps, "dataDir" | "composeFile" | "run" | "fetch" | "clock" | "docker">,
  rollback: RollbackMetadata,
  backupBundle: BackupBundle,
  readyUrl: string,
): Promise<RollbackRecovery> {
  try {
    let docker = deps.docker;
    if (!docker) {
      const ensured = await ensureDocker({ run: deps.run });
      docker = ensured.ok ? ensured.invocation : { command: "docker", prefixArgs: [] };
    }
    return await performCompleteRollback({
      ...deps,
      docker,
      rollback,
      backupBundle,
      readyUrl,
    });
  } catch (error) {
    return {
      status: "manual_recovery_required",
      message: error instanceof Error ? error.message : "rollback failed",
      completedSteps: [],
      failedStep: "rollback-unhandled",
    };
  }
}

export async function runUpdate(deps: UpdateDeps): Promise<UpdateResult> {
  const lock = acquireInstallLock(deps.dataDir, process.pid, deps.clock.now());
  if (!lock.ok) {
    return {
      ok: false,
      release: INSTALL_RELEASE,
      error: lock.message,
    };
  }

  let rollback: RollbackMetadata | null = null;
  let backupBundle: BackupBundle | null = null;
  let backupPath: string | undefined;
  let docker: DockerInvocation | undefined = deps.docker;

  try {
    const ensuredDocker = docker
      ? { ok: true as const, invocation: docker }
      : await ensureDocker({ run: deps.run });
    if (!ensuredDocker.ok) {
      return { ok: false, release: INSTALL_RELEASE, error: ensuredDocker.message };
    }
    docker = ensuredDocker.invocation;

    const envValues = loadEnvValues(deps.dataDir);
    const secrets = collectSecrets(envValues);
    const emit = (event: InstallerEvent) => emitEvent(deps.onEvent, event, secrets);
    const previousChecked = resolvePreviousRelease(deps.dataDir);
    if (!previousChecked.ok) {
      return { ok: false, release: INSTALL_RELEASE, error: previousChecked.message };
    }
    const previousRelease = previousChecked.release;
    const targetChecked = resolveUpdateTarget(deps.targetRelease);
    if (!targetChecked.ok) {
      return { ok: false, release: previousRelease, previousRelease, error: targetChecked.message };
    }
    const targetRelease = targetChecked.release;
    const envFile = envFilePath(deps.dataDir);
    const base = composeBaseArgs(deps.composeFile, envFile);
    const envSnapshotBody = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";

    emit({ step: "requirements", status: "running", message: "Creating database backup" });
    const stamp = deps.clock.now().toISOString().replace(/[:.]/g, "-");
    const dump = await runDockerCommand(deps.run, docker, [
      ...base,
      "exec",
      "-T",
      "postgres",
      "pg_dump",
      "-Fc",
      "-f",
      "-",
      "-U",
      "quibt",
      "quibt",
    ]);
    if (dump.code !== 0) {
      const message = redactInstallerText(dump.stderr || "database backup failed", secrets);
      emit({ step: "requirements", status: "failed", message });
      return { ok: false, release: targetRelease, previousRelease, error: message };
    }

    const backupsDir = path.join(path.resolve(deps.dataDir), "backups");
    backupBundle = writeBackupBundle(
      backupsDir,
      stamp,
      decodeProcessStdoutBytes(dump.stdout, dump.stdoutBytes),
    );
    backupPath = backupBundle.dir;

    const envSnapshotPath = path.join(backupsDir, `pre-update-${stamp}.env`);
    writeAtomicFile(envSnapshotPath, envSnapshotBody, 0o600);

    emit({ step: "requirements", status: "running", message: "Capturing local image references" });
    const images = await captureLocalImages(deps.run, docker, previousRelease);
    if (images.length < requiredImageCount()) {
      const message =
        "Not all required local images were found for the current release; update aborted.";
      emit({ step: "requirements", status: "failed", message });
      return { ok: false, release: targetRelease, previousRelease, backupPath, error: message };
    }

    rollback = {
      release: previousRelease,
      images,
      envSnapshotPath,
      backupBundleDir: backupBundle.dir,
      savedAt: deps.clock.now().toISOString(),
    };
    writeAtomicFile(
      path.join(path.resolve(deps.dataDir), "rollback-images.json"),
      `${JSON.stringify(rollback, null, 2)}\n`,
      0o600,
    );
    emit({
      step: "requirements",
      status: "succeeded",
      message: "Backup and rollback metadata verified",
      detail: { backupPath, imageCount: images.length },
    });

    emit({ step: "images", status: "running", message: `Pulling release ${targetRelease}` });
    writeAtomicFile(envFile, updateEnvRelease(envSnapshotBody, targetRelease), 0o600);

    const pull = await runDockerCommand(
      deps.run,
      docker,
      composeInvocation("packaged", deps.composeFile, envFile, "pull"),
    );
    if (pull.code !== 0) {
      throw new Error(redactInstallerText(pull.stderr || "image pull failed", secrets));
    }
    emit({ step: "images", status: "succeeded", message: "Images pulled" });

    emit({ step: "services", status: "running", message: "Ensuring postgres is up" });
    const postgresUp = await runDockerCommand(
      deps.run,
      docker,
      postgresUpInvocation("packaged", deps.composeFile, envFile),
    );
    if (postgresUp.code !== 0) {
      throw new Error(redactInstallerText(postgresUp.stderr || "postgres failed", secrets));
    }

    emit({ step: "database", status: "running", message: "Running migrations" });
    const migrate = await runDockerCommand(
      deps.run,
      docker,
      migrateInvocation(composeBaseArgs(deps.composeFile, envFile)),
    );
    if (migrate.code !== 0) {
      throw new Error(
        redactInstallerText(migrationFailureMessage(migrate.stderr || migrate.stdout), secrets),
      );
    }
    emit({ step: "database", status: "succeeded", message: "Migrations applied" });

    emit({ step: "services", status: "running", message: "Restarting application services" });
    const appsUp = await runDockerCommand(
      deps.run,
      docker,
      appServicesUpInvocation("packaged", deps.composeFile, envFile),
    );
    if (appsUp.code !== 0) {
      throw new Error(redactInstallerText(appsUp.stderr || "service restart failed", secrets));
    }
    emit({ step: "services", status: "succeeded", message: "Services restarted" });

    const readyUrl = apiReadyUrl(loadEnvValues(deps.dataDir), "http://127.0.0.1:5173");
    emit({ step: "health", status: "running", message: "Waiting for API readiness" });
    const healthy = await waitForReady(readyUrl, deps.fetch, deps.clock);
    if (!healthy) {
      throw new Error(`API not ready after update at ${readyUrl}`);
    }
    emit({ step: "health", status: "succeeded", message: "API ready" });

    const state =
      loadInstallStateForUpdate(deps.dataDir) ??
      initialInstallState(targetRelease, deps.clock.now());
    saveInstallState(deps.dataDir, {
      ...state,
      release: targetRelease,
      updatedAt: deps.clock.now().toISOString(),
    });

    return { ok: true, release: targetRelease, previousRelease, backupPath };
  } catch (error) {
    let recovery: RollbackRecovery | undefined;
    let previous = INSTALL_RELEASE;
    let targetRelease = INSTALL_RELEASE;
    let message = "update failed";

    try {
      const envValues = loadEnvValues(deps.dataDir);
      const secrets = collectSecrets(envValues);
      const emit = (event: InstallerEvent) => emitEvent(deps.onEvent, event, secrets);
      const previousChecked = resolvePreviousRelease(deps.dataDir);
      previous = previousChecked.ok ? previousChecked.release : INSTALL_RELEASE;
      const targetChecked = resolveUpdateTarget(deps.targetRelease);
      targetRelease = targetChecked.ok ? targetChecked.release : INSTALL_RELEASE;
      message = redactInstallerText(
        error instanceof Error ? error.message : "update failed",
        secrets,
      );
      emit({ step: "health", status: "failed", message });

      if (rollback && backupBundle) {
        try {
          if (!existsSync(rollback.envSnapshotPath)) {
            recovery = {
              status: "manual_recovery_required",
              message: "Rollback environment snapshot is missing.",
              completedSteps: [],
              failedStep: "prepare-recovery",
            };
          } else {
            const envBody = readFileSync(rollback.envSnapshotPath, "utf8");
            const readyUrl = apiReadyUrl(parseEnvFile(envBody), "http://127.0.0.1:5173");
            recovery = await restoreRollback(
              { ...deps, docker: docker ?? deps.docker },
              rollback,
              backupBundle,
              readyUrl,
            );
          }
        } catch (prepError) {
          recovery = {
            status: "manual_recovery_required",
            message: prepError instanceof Error ? prepError.message : "recovery preparation failed",
            completedSteps: [],
            failedStep: "prepare-recovery",
          };
        }
      }
    } catch (recoveryError) {
      recovery = {
        status: "manual_recovery_required",
        message:
          recoveryError instanceof Error ? recoveryError.message : "recovery preparation failed",
        completedSteps: [],
        failedStep: "prepare-recovery",
      };
      if (message === "update failed" && recoveryError instanceof Error) {
        message = recoveryError.message;
      }
    }

    const recoveryMessage = recovery
      ? recovery.status === "completed"
        ? `${message} Rollback completed.`
        : `${message} Manual recovery required: ${recovery.message}`
      : message;

    return {
      ok: false,
      release: targetRelease,
      previousRelease: previous,
      backupPath,
      recovery,
      error: recoveryMessage,
    };
  } finally {
    releaseInstallLock(deps.dataDir);
  }
}
