import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { type BackupBundle, validateBackupBundle, writeAtomicFile } from "./backup.js";
import { composeInvocation, requiredQuibtImages } from "./compose.js";
import type { DockerInvocation } from "./docker-invocation.js";
import { runDockerCommand } from "./docker-invocation.js";
import type { Clock, ProcessRunner } from "./orchestrator.js";
import { waitForReady } from "./orchestrator-helpers.js";

export interface ImageRollbackRef {
  reference: string;
  id: string;
}

export interface RollbackMetadata {
  release: string;
  images: ImageRollbackRef[];
  envSnapshotPath: string;
  backupBundleDir: string;
  savedAt: string;
}

export interface RollbackRecovery {
  status: "completed" | "manual_recovery_required";
  message: string;
  completedSteps: string[];
  failedStep?: string;
  cleanupWarning?: string;
}

const REQUIRED_IMAGE_COUNT = 3;
export const RESTORE_CONTAINER_PATH = "/tmp/quibt-restore.pgdump";

export function requiredImageCount(): number {
  return REQUIRED_IMAGE_COUNT;
}

async function inspectLocalImage(
  run: ProcessRunner,
  docker: DockerInvocation,
  reference: string,
): Promise<string | null> {
  const result = await runDockerCommand(run, docker, [
    "image",
    "inspect",
    "-f",
    "{{.Id}}",
    reference,
  ]);
  if (result.code !== 0) return null;
  const id = result.stdout.trim();
  return id || null;
}

export async function captureLocalImages(
  run: ProcessRunner,
  docker: DockerInvocation,
  release: string,
): Promise<ImageRollbackRef[]> {
  const refs = requiredQuibtImages(release);
  const images: ImageRollbackRef[] = [];
  for (const reference of refs) {
    const id = await inspectLocalImage(run, docker, reference);
    if (id) images.push({ reference, id });
  }
  return images;
}

async function removeRestoreDump(
  run: ProcessRunner,
  docker: DockerInvocation,
  composeBaseArgs: string[],
): Promise<string | undefined> {
  try {
    const removed = await runDockerCommand(run, docker, [
      ...composeBaseArgs,
      "exec",
      "-T",
      "postgres",
      "rm",
      "-f",
      RESTORE_CONTAINER_PATH,
    ]);
    if (removed.code !== 0) {
      return (
        removed.stderr.trim() ||
        `Failed to remove ${RESTORE_CONTAINER_PATH} from postgres container.`
      );
    }
    return undefined;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : `Failed to remove ${RESTORE_CONTAINER_PATH} from postgres container.`;
  }
}

async function restoreDatabase(
  run: ProcessRunner,
  docker: DockerInvocation,
  composeBaseArgs: string[],
  bundle: BackupBundle,
): Promise<
  { ok: true; cleanupWarning?: string } | { ok: false; message: string; cleanupWarning?: string }
> {
  if (!existsSync(bundle.dumpPath)) {
    return { ok: false, message: "Database backup file is missing." };
  }

  let failureMessage: string | undefined;
  let succeeded = false;
  let cleanupWarning: string | undefined;
  try {
    const copy = await runDockerCommand(run, docker, [
      ...composeBaseArgs,
      "cp",
      bundle.dumpPath,
      `postgres:${RESTORE_CONTAINER_PATH}`,
    ]);
    if (copy.code !== 0) {
      failureMessage =
        copy.stderr.trim() || "Failed to copy database backup into postgres container.";
    } else {
      const restore = await runDockerCommand(run, docker, [
        ...composeBaseArgs,
        "exec",
        "-T",
        "postgres",
        "pg_restore",
        "--clean",
        "--if-exists",
        "--single-transaction",
        "-U",
        "quibt",
        "-d",
        "quibt",
        RESTORE_CONTAINER_PATH,
      ]);
      if (restore.code !== 0) {
        failureMessage = restore.stderr.trim() || "Database restore failed.";
      } else {
        succeeded = true;
      }
    }
  } finally {
    cleanupWarning = await removeRestoreDump(run, docker, composeBaseArgs);
  }
  if (!succeeded) {
    return {
      ok: false,
      message: failureMessage ?? "Database restore failed.",
      cleanupWarning,
    };
  }
  return { ok: true, cleanupWarning };
}

export async function performCompleteRollback(deps: {
  dataDir: string;
  composeFile: string;
  run: ProcessRunner;
  docker: DockerInvocation;
  fetch: typeof fetch;
  clock: Clock;
  rollback: RollbackMetadata;
  backupBundle: BackupBundle;
  readyUrl: string;
}): Promise<RollbackRecovery> {
  const completedSteps: string[] = [];
  let cleanupWarning: string | undefined;
  const envFile = path.join(path.resolve(deps.dataDir), "quibt.env");
  const composeBaseArgs = composeInvocation("packaged", deps.composeFile, envFile, "up").slice(
    0,
    -3,
  );

  if (!validateBackupBundle(deps.backupBundle)) {
    return {
      status: "manual_recovery_required",
      message: "Rollback aborted: backup bundle failed validation.",
      completedSteps,
      failedStep: "validate-backup",
    };
  }
  completedSteps.push("validate-backup");

  if (deps.rollback.images.length < REQUIRED_IMAGE_COUNT) {
    return {
      status: "manual_recovery_required",
      message: "Rollback aborted: not all required local images were captured.",
      completedSteps,
      failedStep: "validate-images",
    };
  }
  completedSteps.push("validate-images");

  const dbRestore = await restoreDatabase(
    deps.run,
    deps.docker,
    composeBaseArgs,
    deps.backupBundle,
  );
  if (dbRestore.cleanupWarning) cleanupWarning = dbRestore.cleanupWarning;
  if (!dbRestore.ok) {
    return {
      status: "manual_recovery_required",
      message: dbRestore.message,
      completedSteps,
      failedStep: "restore-database",
      cleanupWarning,
    };
  }
  completedSteps.push("restore-database");

  if (!existsSync(deps.rollback.envSnapshotPath)) {
    return {
      status: "manual_recovery_required",
      message: "Rollback aborted: environment snapshot is missing.",
      completedSteps,
      failedStep: "restore-env",
      cleanupWarning,
    };
  }
  const envBody = readFileSync(deps.rollback.envSnapshotPath);
  writeAtomicFile(envFile, envBody.toString("utf8"), 0o600);
  completedSteps.push("restore-env");

  for (const image of deps.rollback.images) {
    const current = await inspectLocalImage(deps.run, deps.docker, image.reference);
    if (current === image.id) continue;
    const tag = await runDockerCommand(deps.run, deps.docker, ["tag", image.id, image.reference]);
    if (tag.code !== 0) {
      return {
        status: "manual_recovery_required",
        message: `Failed to retag ${image.reference} during rollback.`,
        completedSteps,
        failedStep: "retag-images",
        cleanupWarning,
      };
    }
  }
  completedSteps.push("retag-images");

  const up = await runDockerCommand(
    deps.run,
    deps.docker,
    composeInvocation("packaged", deps.composeFile, envFile, "up"),
  );
  if (up.code !== 0) {
    return {
      status: "manual_recovery_required",
      message: "Failed to restart services during rollback.",
      completedSteps,
      failedStep: "compose-up",
      cleanupWarning,
    };
  }
  completedSteps.push("compose-up");

  const healthy = await waitForReady(deps.readyUrl, deps.fetch, deps.clock);
  if (!healthy) {
    return {
      status: "manual_recovery_required",
      message: `API not ready after rollback at ${deps.readyUrl}`,
      completedSteps,
      failedStep: "health-ready",
      cleanupWarning,
    };
  }
  completedSteps.push("health-ready");

  const message = cleanupWarning
    ? `Rollback completed. Cleanup warning: ${cleanupWarning}`
    : "Rollback completed.";

  return {
    status: "completed",
    message,
    completedSteps,
    cleanupWarning,
  };
}
