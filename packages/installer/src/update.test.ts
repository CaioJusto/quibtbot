import { Buffer } from "node:buffer";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PG_CUSTOM_DUMP_MAGIC } from "./backup.js";
import { ensureInstallEnvironment } from "./environment.js";
import { readInstallLock } from "./install-lock.js";
import type { ProcessRunner } from "./orchestrator.js";
import { initialInstallState, saveInstallState } from "./state-persist.js";
import { runUpdate } from "./update.js";

const COMPOSE_FILE = path.resolve("infra/compose/docker-compose.desktop.yml");

function validCustomDump(): Buffer {
  return Buffer.concat([PG_CUSTOM_DUMP_MAGIC, Buffer.alloc(128, 0)]);
}

function seedInstalledState(dataDir: string): void {
  ensureInstallEnvironment(dataDir, "http://127.0.0.1:5173");
  saveInstallState(dataDir, {
    ...initialInstallState("0.2.11", new Date("2026-08-17T00:00:00.000Z")),
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

function makeRunner(
  mode: "success" | "up-fail" | "migrate-fail" | "health-fail" | "bad-backup",
): ProcessRunner {
  let upAttempts = 0;
  const dump = validCustomDump();
  return {
    async run(command, args) {
      const joined = [command, ...args].join(" ");
      if (joined.includes("pg_dump")) {
        if (mode === "bad-backup") {
          return { code: 0, stdout: "not-a-dump", stderr: "" };
        }
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
        return { code: 0, stdout: "RESTORE", stderr: "" };
      }
      if (joined.includes("image inspect")) {
        const reference = args.at(-1) ?? "";
        return { code: 0, stdout: `${imageInspectResponse(reference)}\n`, stderr: "" };
      }
      if (joined.includes("docker tag")) return { code: 0, stdout: "", stderr: "" };
      if (joined.includes(" pull")) return { code: 0, stdout: "", stderr: "" };
      if (joined.includes(" up")) {
        upAttempts += 1;
        if (mode === "up-fail" && upAttempts === 1) {
          return { code: 1, stdout: "", stderr: "up failed" };
        }
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

describe("runUpdate", () => {
  it("creates verified backup, retains local image ids, and only changes env after backup", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-update-"));
    seedInstalledState(dataDir);
    const envBefore = readFileSync(path.join(dataDir, "quibt.env"), "utf8");

    const result = await runUpdate({
      dataDir,
      composeFile: COMPOSE_FILE,
      targetRelease: "0.2.11",
      run: makeRunner("success"),
      fetch: async (url) => {
        if (String(url).endsWith("/ready")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response("down", { status: 503 });
      },
      clock: { now: () => new Date("2026-08-17T01:00:00.000Z"), sleep: async () => undefined },
    });

    expect(result.ok).toBe(true);
    expect(result.backupPath).toBeTruthy();
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(statSync(path.join(result.backupPath!, "dump.pgdump")).mode & 0o777).toBe(0o600);

    const rollback = JSON.parse(
      readFileSync(path.join(dataDir, "rollback-images.json"), "utf8"),
    ) as { release: string; images: Array<{ reference: string; id: string }> };
    expect(rollback.release).toBe("0.2.11");
    expect(rollback.images).toEqual([
      { reference: "ghcr.io/quibt/quibt-stack:0.2.11", id: "sha256:stack-old" },
      { reference: "ghcr.io/quibt/quibt-supervisor:0.2.11", id: "sha256:supervisor-old" },
      { reference: "ghcr.io/quibt/quibt-computer:0.2.11", id: "sha256:computer-old" },
    ]);
    expect(readFileSync(path.join(dataDir, "quibt.env"), "utf8")).toBe(envBefore);
  });

  it("fails when backup verification does not match a pgcustom dump", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-update-fail-"));
    seedInstalledState(dataDir);

    const result = await runUpdate({
      dataDir,
      composeFile: COMPOSE_FILE,
      run: makeRunner("bad-backup"),
      fetch: async () => new Response("down", { status: 503 }),
      clock: { now: () => new Date(), sleep: async () => undefined },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/backup verification failed/i);
    expect(readInstallLock(dataDir)).toBeNull();
  });

  it("rolls back env and images when service restart fails", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-update-rollback-"));
    seedInstalledState(dataDir);
    const envBefore = readFileSync(path.join(dataDir, "quibt.env"), "utf8");

    const result = await runUpdate({
      dataDir,
      composeFile: COMPOSE_FILE,
      targetRelease: "0.2.11",
      run: makeRunner("up-fail"),
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
    expect(readFileSync(path.join(dataDir, "quibt.env"), "utf8")).toBe(envBefore);
    expect(readInstallLock(dataDir)).toBeNull();
  });

  it("rolls back when migration fails", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-update-migrate-"));
    seedInstalledState(dataDir);
    const envBefore = readFileSync(path.join(dataDir, "quibt.env"), "utf8");

    const result = await runUpdate({
      dataDir,
      composeFile: COMPOSE_FILE,
      targetRelease: "0.2.11",
      run: makeRunner("migrate-fail"),
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
    expect(readFileSync(path.join(dataDir, "quibt.env"), "utf8")).toBe(envBefore);
    expect(result.error).toMatch(/quibt-migrate is missing/i);
  });

  it("reports manual recovery when rollback health fails", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-update-health-"));
    seedInstalledState(dataDir);

    const result = await runUpdate({
      dataDir,
      composeFile: COMPOSE_FILE,
      targetRelease: "0.2.11",
      run: makeRunner("health-fail"),
      fetch: async () => new Response("down", { status: 503 }),
      clock: { now: () => new Date("2026-08-17T01:00:00.000Z"), sleep: async () => undefined },
    });

    expect(result.ok).toBe(false);
    expect(result.recovery?.status).toBe("manual_recovery_required");
    expect(result.recovery?.failedStep).toBe("health-ready");
  });
});
