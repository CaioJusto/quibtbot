import { Buffer } from "node:buffer";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PG_CUSTOM_DUMP_MAGIC, writeBackupBundle } from "./backup.js";
import { parseComposePsOutput } from "./compose-ps.js";
import { ensureDocker } from "./docker-requirements.js";
import { ensureInstallEnvironment } from "./environment.js";
import { acquireInstallLock, releaseInstallLock } from "./install-lock.js";
import type { ProcessRunner } from "./orchestrator.js";
import { runInstall } from "./orchestrator.js";
import { probeDeploymentNeedsFirstOwner } from "./orchestrator-helpers.js";
import { canRevealPairingSecrets } from "./pairing-output.js";
import { resolveUpdateTarget } from "./release-allowlist.js";
import { initialInstallState, saveInstallState } from "./state-persist.js";
import { runUpdate } from "./update.js";

const COMPOSE_FILE = path.resolve("infra/compose/docker-compose.desktop.yml");
const PUBLIC_URL = "http://127.0.0.1:5173";

function validCustomDump(): Buffer {
  return Buffer.concat([PG_CUSTOM_DUMP_MAGIC, Buffer.alloc(128, 0)]);
}

function seedInstalledState(dataDir: string): void {
  ensureInstallEnvironment(dataDir, PUBLIC_URL);
  saveInstallState(dataDir, {
    ...initialInstallState("0.2.9", new Date("2026-08-17T00:00:00.000Z")),
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

function imageInspectResponse(reference: string): string {
  if (reference.includes("quibt-stack")) return "sha256:stack-old";
  if (reference.includes("quibt-supervisor")) return "sha256:supervisor-old";
  if (reference.includes("quibt-computer")) return "sha256:computer-old";
  return "sha256:unknown";
}

function makeUpdateRunner(
  mode: "success" | "migrate-fail" | "health-fail" | "rollback-db-fail" | "rollback-health-fail",
): ProcessRunner {
  let _upAttempts = 0;
  const dump = validCustomDump();
  return {
    async run(command, args) {
      const joined = [command, ...args].join(" ");
      if (joined.includes("pg_dump")) {
        return {
          code: 0,
          stdout: dump.toString("latin1"),
          stderr: "",
          stdoutBytes: dump,
        };
      }
      if (joined.includes(" compose") && joined.includes(" cp ")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (joined.includes("pg_restore")) {
        if (mode === "rollback-db-fail") {
          return { code: 1, stdout: "", stderr: "restore failed" };
        }
        return { code: 0, stdout: "RESTORE", stderr: "" };
      }
      if (joined.includes("image inspect")) {
        const reference = args.at(-1) ?? "";
        return { code: 0, stdout: `${imageInspectResponse(reference)}\n`, stderr: "" };
      }
      if (joined.includes("docker tag")) return { code: 0, stdout: "", stderr: "" };
      if (joined.includes(" pull")) return { code: 0, stdout: "", stderr: "" };
      if (joined.includes(" up")) {
        _upAttempts += 1;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (joined.includes("quibt-migrate") && mode === "migrate-fail") {
        return { code: 1, stdout: "", stderr: "pnpm: not found" };
      }
      if (joined.includes("quibt-migrate")) return { code: 0, stdout: "ok", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

describe("install lock race", () => {
  it("uses wx acquisition and only clears stale locks when pid is dead", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-lock-race-"));
    const alive = (pid: number) => pid === 111;
    expect(acquireInstallLock(dataDir, 111, new Date(), alive).ok).toBe(true);
    expect(acquireInstallLock(dataDir, 222, new Date(), alive).ok).toBe(false);
    expect(acquireInstallLock(dataDir, 333, new Date(), () => false).ok).toBe(true);
    releaseInstallLock(dataDir, 333);
  });

  it("creates dataDir before acquiring the lock", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "quibt-lock-parent-"));
    const dataDir = path.join(parent, "nested", "quibt");
    expect(existsSync(dataDir)).toBe(false);
    const lock = acquireInstallLock(dataDir, 999, new Date(), () => false);
    expect(lock.ok).toBe(true);
    expect(existsSync(dataDir)).toBe(true);
    releaseInstallLock(dataDir, 999);
  });
});

describe("deploymentNeedsFirstOwner probe", () => {
  it("requires explicit boolean and retries 429/5xx", async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("busy", { status: 429, headers: { "Retry-After": "0" } });
      }
      return new Response(JSON.stringify({ json: { needsFirstOwner: true } }), { status: 200 });
    };

    const probe = await probeDeploymentNeedsFirstOwner("http://127.0.0.1:3100", fetchImpl);
    expect(probe).toEqual({ ok: true, needsFirstOwner: true });
    expect(attempts).toBeGreaterThan(1);
  });

  it("fails on malformed JSON and missing boolean", async () => {
    const malformed = await probeDeploymentNeedsFirstOwner(
      "http://127.0.0.1:3100",
      async () => new Response("not-json", { status: 200 }),
    );
    expect(malformed.ok).toBe(false);

    const missing = await probeDeploymentNeedsFirstOwner(
      "http://127.0.0.1:3100",
      async () => new Response(JSON.stringify({ json: { ok: true } }), { status: 200 }),
    );
    expect(missing.ok).toBe(false);
  });
});

describe("update target allowlist", () => {
  it("defaults to embedded release and rejects env-driven external versions", () => {
    expect(resolveUpdateTarget(undefined).ok).toBe(true);
    expect(resolveUpdateTarget("0.2.9").ok).toBe(true);
    expect(resolveUpdateTarget("9.9.9").ok).toBe(false);
  });
});

describe("pairing secret reveal policy", () => {
  it("requires interactive tty or --show-sensitive opt-in", () => {
    expect(canRevealPairingSecrets({ isTty: true })).toBe(true);
    expect(canRevealPairingSecrets({ showSensitive: true })).toBe(true);
    expect(canRevealPairingSecrets({ isTty: false, showSensitive: false })).toBe(false);
  });
});

describe("compose ps array parsing", () => {
  it("parses full JSON arrays", () => {
    const parsed = parseComposePsOutput(
      JSON.stringify([
        { Service: "api", State: "running" },
        { Service: "web", State: "running" },
        { Service: "postgres", State: "running" },
      ]),
    );
    expect(parsed.rows).toHaveLength(3);
  });
});

describe("ensureDocker sudo", () => {
  it("uses sudo -n for docker info and install commands when not root", async () => {
    const commands: string[] = [];
    const originalGetUid = process.getuid;
    process.getuid = () => 1000;

    try {
      const result = await ensureDocker({
        platform: "linux",
        run: {
          async run(command, args) {
            commands.push([command, ...args].join(" "));
            if (command === "docker" && args[0] === "info") {
              return { code: 1, stdout: "", stderr: "permission denied" };
            }
            if (
              command === "sudo" &&
              args[0] === "-n" &&
              args[1] === "docker" &&
              (args[2] === "info" || args[2] === "compose")
            ) {
              return { code: 0, stdout: "", stderr: "" };
            }
            return { code: 1, stdout: "", stderr: "unsupported" };
          },
        },
      });
      expect(result.ok).toBe(true);
      expect(commands.some((entry) => entry.includes("sudo -n docker info"))).toBe(true);
    } finally {
      process.getuid = originalGetUid;
    }
  });
});

describe("first install on missing path", () => {
  it("creates the data directory and writes env on first run", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "quibt-first-install-"));
    const dataDir = path.join(parent, "brand-new", "quibt");
    expect(existsSync(dataDir)).toBe(false);

    const result = await runInstall({
      dataDir,
      publicUrl: PUBLIC_URL,
      composeFile: COMPOSE_FILE,
      composeMode: "packaged",
      run: {
        async run(command, args) {
          const joined = [command, ...args].join(" ");
          if (command === "docker" && args[0] === "info") {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (
            joined.includes(" pull") ||
            joined.includes(" up") ||
            joined.includes("quibt-migrate")
          ) {
            return { code: 0, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/ready")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith("/api/bootstrap/invites")) {
          return new Response(
            JSON.stringify({
              code: "PAIR1234",
              token: "pair-token",
              expiresAt: "2026-08-17T01:00:00.000Z",
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/rpc/health") && init?.method === "POST") {
          return new Response(JSON.stringify({ json: { needsFirstOwner: true } }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
      clock: { now: () => new Date("2026-08-17T00:00:00.000Z"), sleep: async () => undefined },
      platform: "linux",
    });

    expect(result.ok).toBe(true);
    expect(existsSync(path.join(dataDir, "quibt.env"))).toBe(true);
    expect(existsSync(path.join(dataDir, "install-state.json"))).toBe(true);
  });
});

describe("complete rollback", () => {
  it("restores database, env bytes, images, compose, and health before reporting completed", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-rollback-complete-"));
    seedInstalledState(dataDir);
    const exactEnv = readFileSync(path.join(dataDir, "quibt.env"), "utf8");

    const result = await runUpdate({
      dataDir,
      composeFile: COMPOSE_FILE,
      targetRelease: "0.2.9",
      run: makeUpdateRunner("migrate-fail"),
      fetch: async (url) => {
        if (String(url).endsWith("/ready")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response("down", { status: 503 });
      },
      clock: { now: () => new Date("2026-08-17T01:00:00.000Z"), sleep: async () => undefined },
    });

    expect(result.ok).toBe(false);
    expect(result.recovery?.status).toBe("completed");
    expect(result.recovery?.completedSteps).toEqual(
      expect.arrayContaining([
        "validate-backup",
        "restore-database",
        "restore-env",
        "retag-images",
        "compose-up",
        "health-ready",
      ]),
    );
    expect(readFileSync(path.join(dataDir, "quibt.env"), "utf8")).toBe(exactEnv);
    expect(result.error).toMatch(/Rollback completed/i);
  });

  it("returns manual recovery when database restore fails", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-rollback-incomplete-"));
    seedInstalledState(dataDir);

    const result = await runUpdate({
      dataDir,
      composeFile: COMPOSE_FILE,
      targetRelease: "0.2.9",
      run: makeUpdateRunner("rollback-db-fail"),
      fetch: async () => new Response("down", { status: 503 }),
      clock: { now: () => new Date("2026-08-17T01:00:00.000Z"), sleep: async () => undefined },
    });

    expect(result.ok).toBe(false);
    expect(result.recovery?.status).toBe("manual_recovery_required");
    expect(result.recovery?.failedStep).toBe("restore-database");
    expect(result.error).toMatch(/Manual recovery required/i);
  });
});

describe("atomic backup bundle", () => {
  it("writes a directory bundle with validated metadata", () => {
    const backupsDir = mkdtempSync(path.join(tmpdir(), "quibt-backup-bundle-"));
    const bundle = writeBackupBundle(backupsDir, "stamp", validCustomDump());
    expect(existsSync(bundle.dumpPath)).toBe(true);
    expect(existsSync(bundle.metaPath)).toBe(true);
    expect(statSync(bundle.dir).isDirectory()).toBe(true);
  });
});
