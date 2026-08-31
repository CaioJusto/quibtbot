import { Buffer } from "node:buffer";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PG_CUSTOM_DUMP_MAGIC, writeBackupBundle } from "./backup.js";
import { INSTALL_RELEASE } from "./compose.js";
import { assessComposeServices } from "./compose-services.js";
import { runDoctor } from "./doctor.js";
import { ensureInstallEnvironment } from "./environment.js";
import { acquireInstallLock, readInstallLock, releaseInstallLock } from "./install-lock.js";
import type { ProcessRunner } from "./orchestrator.js";
import { finalizePairingInstall, runInstall, runStatus } from "./orchestrator.js";
import { performCompleteRollback, RESTORE_CONTAINER_PATH } from "./rollback.js";
import { initialInstallState, loadInstallState } from "./state-persist.js";
import { classifyInstallState as classifyInstallStateDirect } from "./state-validation.js";
import { runUpdate } from "./update.js";

const COMPOSE_FILE = path.resolve("infra/compose/docker-compose.desktop.yml");
const PUBLIC_URL = "http://127.0.0.1:5173";

function validCustomDump(): Buffer {
  return Buffer.concat([PG_CUSTOM_DUMP_MAGIC, Buffer.alloc(128, 0)]);
}

function seedInstalledState(dataDir: string): void {
  ensureInstallEnvironment(dataDir, PUBLIC_URL);
  writeFileSync(
    path.join(dataDir, "install-state.json"),
    `${JSON.stringify({
      ...initialInstallState("0.2.18", new Date("2026-08-17T00:00:00.000Z")),
      completed: [
        "requirements",
        "environment",
        "images",
        "services",
        "database",
        "health",
        "pairing",
      ],
    })}\n`,
    { mode: 0o600 },
  );
}

describe("embedded release validation", () => {
  it("rejects complete state from another trusted semver as update_required", () => {
    const classified = classifyInstallStateDirect({
      version: 1,
      release: "0.1.0",
      completed: [
        "requirements",
        "environment",
        "images",
        "services",
        "database",
        "health",
        "pairing",
      ],
      updatedAt: "2026-08-17T00:00:00.000Z",
    });
    expect(classified.ok).toBe(false);
    if (!classified.ok) {
      expect(classified.reason).toBe("update_required");
      expect(classified.message).toMatch(/update before continuing/i);
    }
  });

  it("blocks runInstall when on-disk state requires update", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-install-update-required-"));
    ensureInstallEnvironment(dataDir, PUBLIC_URL);
    writeFileSync(
      path.join(dataDir, "install-state.json"),
      `${JSON.stringify({
        version: 1,
        release: "0.1.0",
        completed: [
          "requirements",
          "environment",
          "images",
          "services",
          "database",
          "health",
          "pairing",
        ],
        updatedAt: "2026-08-17T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );

    const result = await runInstall({
      dataDir,
      publicUrl: PUBLIC_URL,
      composeFile: COMPOSE_FILE,
      composeMode: "packaged",
      run: {
        async run() {
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      fetch: async () => new Response("not found", { status: 404 }),
      clock: { now: () => new Date(), sleep: async () => undefined },
      platform: "linux",
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.error).toMatch(/0\.1\.0/);
  });

  it("reports update_required from runStatus without trusting foreign release", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-status-update-required-"));
    const env = ensureInstallEnvironment(dataDir, PUBLIC_URL);
    writeFileSync(
      env.path,
      readFileSync(env.path, "utf8").replace(
        "QUIBT_STACK_VERSION=0.2.18",
        "QUIBT_STACK_VERSION=0.1.0",
      ),
      { mode: 0o600 },
    );

    const status = await runStatus({
      dataDir,
      publicUrl: PUBLIC_URL,
      composeFile: COMPOSE_FILE,
      run: {
        async run() {
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      fetch: async () => new Response("down", { status: 503 }),
    });

    expect(status.release).toBe(INSTALL_RELEASE);
    expect(status.stateIssue?.reason).toBe("update_required");
  });
});

describe("assessComposeServices health", () => {
  it("fails when Health exists and is not healthy", () => {
    const result = assessComposeServices([
      { Service: "postgres", State: "running", Health: "healthy" },
      { Service: "api", State: "running", Health: "starting" },
      { Service: "web", State: "running", Health: "healthy" },
      { Service: "worker", State: "running", Health: "healthy" },
      { Service: "supervisor", State: "running", Health: "healthy" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.unhealthy).toEqual(["api"]);
    expect(result.message).toMatch(/unhealthy: api/i);
  });

  it("passes when services are running without health data", () => {
    const result = assessComposeServices([
      { Service: "postgres", State: "running" },
      { Service: "api", State: "running" },
      { Service: "web", State: "running" },
      { Service: "worker", State: "running" },
      { Service: "supervisor", State: "running" },
    ]);
    expect(result.ok).toBe(true);
  });
});

describe("backup bundle atomicity", () => {
  it("writes dump and metadata inside temp dir before exposing final bundle", () => {
    const backupsDir = mkdtempSync(path.join(tmpdir(), "quibt-backup-atomic-"));
    const bundle = writeBackupBundle(backupsDir, "stamp", validCustomDump());
    expect(existsSync(bundle.metaPath)).toBe(true);
    expect(existsSync(bundle.dumpPath)).toBe(true);
    const meta = JSON.parse(readFileSync(bundle.metaPath, "utf8")) as { path: string };
    expect(meta.path).toBe(bundle.dumpPath);
    expect(existsSync(path.join(backupsDir, `.tmp-pre-update-stamp-${process.pid}`))).toBe(false);
  });
});

describe("finalizePairingInstall lock", () => {
  it("acquires the install lock while finalizing pairing", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-finalize-lock-"));
    writeFileSync(
      path.join(dataDir, "install-state.json"),
      `${JSON.stringify({
        version: 1,
        release: "0.2.18",
        completed: ["requirements", "environment", "images", "services", "database", "health"],
        updatedAt: "2026-08-17T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );

    const alive = (pid: number) => pid === 4242;
    const blocker = acquireInstallLock(dataDir, 4242, new Date(), alive);
    expect(blocker.ok).toBe(true);

    await expect(
      finalizePairingInstall(
        dataDir,
        { now: () => new Date(), sleep: async () => undefined },
        undefined,
        alive,
      ),
    ).rejects.toThrow(/already running/i);

    releaseInstallLock(dataDir, 4242);
    await finalizePairingInstall(
      dataDir,
      { now: () => new Date(), sleep: async () => undefined },
      undefined,
      () => false,
    );
    expect(loadInstallState(dataDir)?.completed).toContain("pairing");
    expect(readInstallLock(dataDir)).toBeNull();
  });
});

describe("update recovery preparation", () => {
  it("never throws while preparing rollback and returns manual_recovery_required", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-update-recovery-prep-"));
    seedInstalledState(dataDir);
    const dump = validCustomDump();

    const runner: ProcessRunner = {
      async run(command, args) {
        const joined = [command, ...args].join(" ");
        if (joined.includes("pg_dump")) {
          return { code: 0, stdout: dump.toString("latin1"), stderr: "", stdoutBytes: dump };
        }
        if (joined.includes("image inspect")) {
          return { code: 0, stdout: "sha256:test\n", stderr: "" };
        }
        if (joined.includes(" pull")) return { code: 0, stdout: "", stderr: "" };
        if (joined.includes(" up")) {
          const snapshot = path.join(dataDir, "backups", "pre-update-2026-08-17T01-00-00-000Z.env");
          if (existsSync(snapshot)) unlinkSync(snapshot);
          return { code: 1, stdout: "", stderr: "up failed" };
        }
        if (joined.includes("quibt-migrate")) return { code: 0, stdout: "", stderr: "" };
        if (joined.includes("pg_restore") || joined.includes(" rm ")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (joined.includes(" compose") && joined.includes(" cp ")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    const result = await runUpdate({
      dataDir,
      composeFile: COMPOSE_FILE,
      // A suíte não pode depender do disco livre de quem a roda.
      statfs: async () => ({ bsize: 4096, bavail: 25_000_000 }),
      targetRelease: "0.2.18",
      run: runner,
      fetch: async (url) =>
        String(url).endsWith("/ready")
          ? new Response(JSON.stringify({ ok: true }), { status: 200 })
          : new Response("down", { status: 503 }),
      clock: { now: () => new Date("2026-08-17T01:00:00.000Z"), sleep: async () => undefined },
    });

    expect(result.ok).toBe(false);
    expect(result.recovery).toBeDefined();
    expect(result.recovery?.status).toBe("manual_recovery_required");
    expect(result.recovery?.failedStep).toBe("prepare-recovery");
  });
});

describe("restore container cleanup", () => {
  it("always removes the restore dump and reports cleanup failures without hiding success", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-restore-cleanup-"));
    seedInstalledState(dataDir);
    const bundle = writeBackupBundle(path.join(dataDir, "backups"), "stamp", validCustomDump());
    const envSnapshotPath = path.join(dataDir, "backups", "pre-update-stamp.env");
    writeFileSync(envSnapshotPath, readFileSync(path.join(dataDir, "quibt.env"), "utf8"), {
      mode: 0o600,
    });

    const commands: string[] = [];
    const recovery = await performCompleteRollback({
      dataDir,
      composeFile: COMPOSE_FILE,
      docker: { command: "docker", prefixArgs: [] },
      run: {
        async run(command, args) {
          commands.push([command, ...args].join(" "));
          if (args.includes("pg_restore")) return { code: 0, stdout: "", stderr: "" };
          if (args.includes("rm")) return { code: 1, stdout: "", stderr: "cleanup failed" };
          if (args.includes("tag")) return { code: 0, stdout: "", stderr: "" };
          if (args.includes(" cp ")) return { code: 0, stdout: "", stderr: "" };
          if (args.includes(" up")) return { code: 0, stdout: "", stderr: "" };
          if (args.includes("image inspect")) return { code: 0, stdout: "sha256:id\n", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      fetch: async (url) =>
        String(url).endsWith("/ready")
          ? new Response(JSON.stringify({ ok: true }), { status: 200 })
          : new Response("down", { status: 503 }),
      clock: { now: () => new Date(), sleep: async () => undefined },
      rollback: {
        release: "0.2.18",
        images: [
          { reference: "ghcr.io/quibt/quibt-stack:0.2.18", id: "sha256:id" },
          { reference: "ghcr.io/quibt/quibt-supervisor:0.2.18", id: "sha256:id" },
          { reference: "ghcr.io/quibt/quibt-computer:0.2.18", id: "sha256:id" },
        ],
        envSnapshotPath,
        backupBundleDir: bundle.dir,
        savedAt: new Date().toISOString(),
      },
      backupBundle: bundle,
      readyUrl: "http://127.0.0.1:3100/ready",
    });

    expect(recovery.status).toBe("completed");
    expect(
      commands.some((entry) => entry.includes(`rm`) && entry.includes(RESTORE_CONTAINER_PATH)),
    ).toBe(true);
    expect(recovery.cleanupWarning).toMatch(/cleanup failed/i);
    expect(recovery.message).toMatch(/Cleanup warning/i);
  });
});

describe("doctor embedded release", () => {
  it("flags foreign env release even when services respond", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-doctor-release-"));
    const env = ensureInstallEnvironment(dataDir, PUBLIC_URL);
    writeFileSync(
      env.path,
      readFileSync(env.path, "utf8").replace(
        "QUIBT_STACK_VERSION=0.2.18",
        "QUIBT_STACK_VERSION=0.1.0",
      ),
      { mode: 0o600 },
    );

    const report = await runDoctor({
      dataDir,
      publicUrl: PUBLIC_URL,
      composeFile: COMPOSE_FILE,
      run: {
        async run(command, args) {
          const joined = [command, ...args].join(" ");
          if (joined.includes("docker version")) {
            return {
              code: 0,
              stdout: JSON.stringify({ Server: { Version: "27.0.0" } }),
              stderr: "",
            };
          }
          if (joined.includes(" ps ")) {
            return {
              code: 0,
              stdout: JSON.stringify([
                { Service: "postgres", State: "running", Health: "healthy" },
                { Service: "api", State: "running", Health: "healthy" },
                { Service: "web", State: "running", Health: "healthy" },
                { Service: "worker", State: "running", Health: "healthy" },
                { Service: "supervisor", State: "running", Health: "healthy" },
              ]),
              stderr: "",
            };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      fetch: async (input) =>
        String(input).endsWith("/ready")
          ? new Response(JSON.stringify({ ok: true }), { status: 200 })
          : new Response("down", { status: 503 }),
      checkPort: async () => true,
    });

    expect(report.checks.manifest?.ok).toBe(false);
    expect(report.checks.manifest?.message).toMatch(/0\.1\.0/);
  });
});
