import { Buffer } from "node:buffer";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PG_CUSTOM_DUMP_MAGIC, writeBackupBundle } from "./backup.js";
import { ensureInstallEnvironment } from "./environment.js";
import { readInstallLock } from "./install-lock.js";
import { finalizePairingInstall, runInstall } from "./orchestrator.js";
import { resolvePreviousRelease } from "./release-allowlist.js";
import { initialInstallState, loadInstallState, saveInstallState } from "./state-persist.js";
import { restoreRollback, runUpdate } from "./update.js";

const COMPOSE_FILE = path.resolve("infra/compose/docker-compose.desktop.yml");
const PUBLIC_URL = "http://127.0.0.1:5173";

function validCustomDump(): Buffer {
  return Buffer.concat([PG_CUSTOM_DUMP_MAGIC, Buffer.alloc(128, 0)]);
}

function seedInstalledState(dataDir: string): void {
  ensureInstallEnvironment(dataDir, PUBLIC_URL);
  saveInstallState(dataDir, {
    ...initialInstallState("0.2.14", new Date("2026-08-17T00:00:00.000Z")),
    completed: [
      "requirements",
      "environment",
      "images",
      "services",
      "database",
      "health",
      "pairing",
    ],
  });
}

describe("lock release on pre-orchestration throw", () => {
  it("releases update lock when previous release validation fails inside try", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-lock-throw-"));
    ensureInstallEnvironment(dataDir, PUBLIC_URL);

    const result = await runUpdate({
      dataDir,
      composeFile: COMPOSE_FILE,
      // A suíte não pode depender do disco livre de quem a roda.
      statfs: async () => ({ bsize: 4096, bavail: 25_000_000 }),
      run: {
        async run() {
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      fetch: async () => new Response("down", { status: 503 }),
      clock: { now: () => new Date(), sleep: async () => undefined },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Install state is missing/i);
    expect(readInstallLock(dataDir)).toBeNull();
  });
});

describe("pairing completion ordering", () => {
  it("does not persist pairing step until finalizePairingInstall is called", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-pairing-order-"));
    writeFileSync(
      path.join(dataDir, "install-state.json"),
      `${JSON.stringify({
        version: 1,
        release: "0.2.14",
        completed: ["requirements", "environment", "images", "services", "database", "health"],
        updatedAt: "2026-08-17T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    ensureInstallEnvironment(dataDir, PUBLIC_URL);

    const result = await runInstall({
      dataDir,
      publicUrl: PUBLIC_URL,
      composeFile: COMPOSE_FILE,
      composeMode: "packaged",
      run: {
        async run(command, args) {
          if (command === "docker" && args[0] === "info") {
            return { code: 0, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/rpc/health") && init?.method === "POST") {
          return new Response(JSON.stringify({ json: { needsFirstOwner: true } }), { status: 200 });
        }
        if (url.endsWith("/api/bootstrap/invites")) {
          return new Response(
            JSON.stringify({
              code: "PAIR1",
              token: "tok",
              expiresAt: "2026-08-17T01:00:00.000Z",
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      },
      clock: { now: () => new Date(), sleep: async () => undefined },
      platform: "linux",
    });

    expect(result.ok).toBe(true);
    expect(result.pairingPending).toBe(true);
    expect(loadInstallState(dataDir)?.completed).not.toContain("pairing");

    await finalizePairingInstall(dataDir, { now: () => new Date(), sleep: async () => undefined });
    expect(loadInstallState(dataDir)?.completed).toContain("pairing");
  });
});

describe("previous release validation", () => {
  it("aborts when env and install state releases diverge", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-prev-release-"));
    const env = ensureInstallEnvironment(dataDir, PUBLIC_URL);
    saveInstallState(dataDir, initialInstallState("0.2.14", new Date()));
    writeFileSync(
      env.path,
      readFileSync(env.path, "utf8").replace(
        "QUIBT_STACK_VERSION=0.2.14",
        "QUIBT_STACK_VERSION=0.1.0",
      ),
      { mode: 0o600 },
    );

    const resolved = resolvePreviousRelease(dataDir);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.message).toMatch(/does not match/i);
  });
});

describe("restoreRollback throw handling", () => {
  it("returns manual_recovery_required when rollback throws", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-restore-throw-"));
    seedInstalledState(dataDir);
    const backupsDir = path.join(dataDir, "backups");
    const bundle = writeBackupBundle(backupsDir, "stamp", validCustomDump());
    const envSnapshotPath = path.join(backupsDir, "pre-update-stamp.env");
    writeFileSync(envSnapshotPath, readFileSync(path.join(dataDir, "quibt.env"), "utf8"), {
      mode: 0o600,
    });

    const recovery = await restoreRollback(
      {
        dataDir,
        composeFile: COMPOSE_FILE,
        run: {
          async run() {
            throw new Error("runner exploded");
          },
        },
        fetch: async () => new Response("down", { status: 503 }),
        clock: { now: () => new Date(), sleep: async () => undefined },
      },
      {
        release: "0.2.14",
        images: [
          { reference: "ghcr.io/quibt/quibt-stack:0.2.14", id: "sha256:a" },
          { reference: "ghcr.io/quibt/quibt-supervisor:0.2.14", id: "sha256:b" },
          { reference: "ghcr.io/quibt/quibt-computer:0.2.14", id: "sha256:c" },
        ],
        envSnapshotPath,
        backupBundleDir: bundle.dir,
        savedAt: new Date().toISOString(),
      },
      bundle,
      "http://127.0.0.1:3100/ready",
    );

    expect(recovery.status).toBe("manual_recovery_required");
    expect(recovery.failedStep).toBe("rollback-unhandled");
  });
});

describe("backup metadata final paths", () => {
  it("records the final dump path and validates checksum before restore", () => {
    const backupsDir = mkdtempSync(path.join(tmpdir(), "quibt-backup-meta-"));
    const bundle = writeBackupBundle(backupsDir, "stamp", validCustomDump());
    const meta = JSON.parse(readFileSync(bundle.metaPath, "utf8")) as {
      path: string;
      format: string;
    };
    expect(meta.path).toBe(bundle.dumpPath);
    expect(meta.format).toBe("pgcustom");
    expect(existsSync(meta.path)).toBe(true);
    expect(statSync(bundle.dir).isDirectory()).toBe(true);
  });
});
