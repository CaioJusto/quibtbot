import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureInstallEnvironment } from "./environment.js";
import {
  acquireInstallLock,
  installLockPath,
  readInstallLock,
  releaseInstallLock,
  touchLockDirMtime,
} from "./install-lock.js";
import { runStatus } from "./orchestrator.js";

const COMPOSE_FILE = path.resolve("infra/compose/docker-compose.desktop.yml");
const PUBLIC_URL = "http://127.0.0.1:5173";

describe("runStatus docker resolution", () => {
  it("resolves sudo -n docker for compose ps when invocation is not injected", async () => {
    const commands: string[] = [];
    const originalGetUid = process.getuid;
    process.getuid = () => 1000;

    try {
      const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-status-sudo-"));
      ensureInstallEnvironment(dataDir, PUBLIC_URL);

      await runStatus({
        dataDir,
        publicUrl: PUBLIC_URL,
        composeFile: COMPOSE_FILE,
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
              args[2] === "info"
            ) {
              return { code: 0, stdout: "", stderr: "" };
            }
            if (command.includes("docker")) {
              return { code: 1, stdout: "", stderr: "permission denied" };
            }
            return { code: 0, stdout: "", stderr: "" };
          },
        },
        fetch: async () => new Response("down", { status: 503 }),
      });

      expect(commands.some((entry) => entry.includes("sudo -n docker info"))).toBe(true);
      expect(
        commands.some(
          (entry) => entry.startsWith("sudo -n docker compose") && entry.includes(" ps "),
        ),
      ).toBe(true);
    } finally {
      process.getuid = originalGetUid;
    }
  });
});

describe("install lock directory without metadata", () => {
  it("treats a recent lock directory without meta.json as busy", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-lock-no-meta-recent-"));
    mkdirSync(path.resolve(dataDir), { recursive: true });
    mkdirSync(installLockPath(dataDir));

    const busy = acquireInstallLock(dataDir, 900, new Date(), () => false, Date.now());
    expect(busy.ok).toBe(false);
    if (!busy.ok) expect(busy.message).toMatch(/busy/i);
    expect(existsSync(installLockPath(dataDir))).toBe(true);
    expect(
      readdirSync(path.resolve(dataDir)).filter((name) =>
        name.startsWith("install.lock.quarantined."),
      ),
    ).toHaveLength(0);
  });

  it("quarantines an old lock directory without meta.json after the stale window", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-lock-no-meta-old-"));
    mkdirSync(path.resolve(dataDir), { recursive: true });
    mkdirSync(installLockPath(dataDir));
    touchLockDirMtime(dataDir, Date.now() - 120_000);

    const recovered = acquireInstallLock(
      dataDir,
      901,
      new Date("2026-08-17T02:00:00.000Z"),
      () => false,
      Date.now(),
    );
    expect(recovered.ok).toBe(true);
    expect(readInstallLock(dataDir)?.pid).toBe(901);
    expect(
      readdirSync(path.resolve(dataDir)).some((name) =>
        name.startsWith("install.lock.quarantined."),
      ),
    ).toBe(true);
    releaseInstallLock(dataDir, 901);
  });

  it("does not quarantine a lock held by a live owner", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-lock-live-owner-"));
    const alive = (pid: number) => pid === 111;
    expect(acquireInstallLock(dataDir, 111, new Date(), alive).ok).toBe(true);

    const blocked = acquireInstallLock(dataDir, 222, new Date(), alive);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.message).toMatch(/pid 111/);
    expect(existsSync(installLockPath(dataDir))).toBe(true);
    expect(
      readdirSync(path.resolve(dataDir)).filter((name) =>
        name.startsWith("install.lock.quarantined."),
      ),
    ).toHaveLength(0);

    releaseInstallLock(dataDir, 111);
  });

  it("writes metadata atomically inside the lock directory", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-lock-atomic-meta-"));
    expect(
      acquireInstallLock(dataDir, 777, new Date("2026-08-17T00:00:00.000Z"), () => false).ok,
    ).toBe(true);
    const lockDir = installLockPath(dataDir);
    expect(statSync(lockDir).isDirectory()).toBe(true);
    expect(readInstallLock(dataDir)).toEqual({
      pid: 777,
      startedAt: "2026-08-17T00:00:00.000Z",
    });
    expect(
      readdirSync(lockDir).filter((name) => name.startsWith("meta.json.") && name.endsWith(".tmp")),
    ).toHaveLength(0);
    releaseInstallLock(dataDir, 777);
  });
});
