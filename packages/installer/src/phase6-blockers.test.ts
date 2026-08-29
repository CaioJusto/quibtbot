import { Buffer } from "node:buffer";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PG_CUSTOM_DUMP_MAGIC, writeBackupBundle } from "./backup.js";
import { dockerArgv, resolveDockerInvocation } from "./docker-invocation.js";
import { ensureDocker } from "./docker-requirements.js";
import { ensureInstallEnvironment } from "./environment.js";
import {
  acquireInstallLock,
  installLockPath,
  readInstallLock,
  releaseInstallLock,
  touchLockMetaMtime,
} from "./install-lock.js";
import type { ProcessRunner } from "./orchestrator.js";
import { runInstall, runStatus } from "./orchestrator.js";
import { resolvePreviousRelease } from "./release-allowlist.js";
import { performCompleteRollback, rollbackComposeOverride } from "./rollback.js";
import {
  inspectInstallState,
  installStatePath,
  loadInstallState,
  loadInstallStateForUpdate,
} from "./state-persist.js";
import {
  classifyInstallStateForInstall,
  classifyInstallStateForUpdate,
  inspectInstallStateStructure,
} from "./state-validation.js";
import { runUpdate } from "./update.js";

const COMPOSE_FILE = path.resolve("infra/compose/docker-compose.desktop.yml");
const PUBLIC_URL = "http://127.0.0.1:5173";

function validCustomDump(): Buffer {
  return Buffer.concat([PG_CUSTOM_DUMP_MAGIC, Buffer.alloc(128, 0)]);
}

function imageInspectResponse(reference: string): string {
  if (reference.includes("quibt-stack")) return "sha256:stack-old";
  if (reference.includes("quibt-supervisor")) return "sha256:supervisor-old";
  if (reference.includes("quibt-computer")) return "sha256:computer-old";
  return "sha256:unknown";
}

function makeSudoDockerRunner(commands: string[]): ProcessRunner {
  return {
    async run(command, args) {
      commands.push([command, ...args].join(" "));
      if (command === "docker" && args[0] === "info") {
        return { code: 1, stdout: "", stderr: "permission denied" };
      }
      if (command === "sudo" && args[0] === "-n" && args[1] === "docker") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

describe("docker invocation propagation", () => {
  it("builds sudo -n docker argv for nested docker subcommands", () => {
    const inv = { command: "sudo", prefixArgs: ["-n", "docker"] };
    expect(dockerArgv(inv, ["compose", "ps"])).toEqual(["sudo", ["-n", "docker", "compose", "ps"]]);
  });

  it("routes compose through a standalone command without changing engine commands", () => {
    const inv = {
      command: "/opt/homebrew/bin/docker",
      prefixArgs: [],
      compose: { command: "/opt/homebrew/bin/docker-compose", prefixArgs: [] },
    };
    expect(dockerArgv(inv, ["compose", "ps"])).toEqual([
      "/opt/homebrew/bin/docker-compose",
      ["ps"],
    ]);
    expect(dockerArgv(inv, ["image", "inspect", "example"])).toEqual([
      "/opt/homebrew/bin/docker",
      ["image", "inspect", "example"],
    ]);
  });

  it("uses Homebrew standalone Compose when Finder PATH hides the plugin", async () => {
    const commands: string[] = [];
    const result = await ensureDocker({
      platform: "darwin",
      run: {
        async run(command, args) {
          commands.push([command, ...args].join(" "));
          if (command === "/opt/homebrew/bin/docker" && args[0] === "info") {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (command === "/opt/homebrew/bin/docker" && args[0] === "compose") {
            return { code: 1, stdout: "", stderr: "unknown command: docker compose" };
          }
          if (command === "/opt/homebrew/bin/docker-compose" && args[0] === "version") {
            return { code: 0, stdout: "Docker Compose version 5.4.0", stderr: "" };
          }
          return { code: 1, stdout: "", stderr: "missing" };
        },
      },
    });

    expect(result).toEqual({
      ok: true,
      invocation: {
        command: "/opt/homebrew/bin/docker",
        prefixArgs: [],
        compose: { command: "/opt/homebrew/bin/docker-compose", prefixArgs: [] },
      },
    });
    expect(commands).toContain("/opt/homebrew/bin/docker-compose version");
  });

  it("keeps standalone Compose routing when resolving Docker outside install", async () => {
    const invocation = await resolveDockerInvocation(
      {
        async run(command, args) {
          if (command === "/opt/homebrew/bin/docker" && args[0] === "info") {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (command === "/opt/homebrew/bin/docker" && args[0] === "compose") {
            return { code: 1, stdout: "", stderr: "unknown command" };
          }
          if (command === "/opt/homebrew/bin/docker-compose" && args[0] === "version") {
            return { code: 0, stdout: "Docker Compose version 5.4.0", stderr: "" };
          }
          return { code: 1, stdout: "", stderr: "missing" };
        },
      },
      { platform: "darwin", homeDir: "/tmp/empty-home" },
    );

    expect(invocation?.compose).toEqual({
      command: "/opt/homebrew/bin/docker-compose",
      prefixArgs: [],
    });
  });

  it("resolves sudo -n docker when direct docker info fails", async () => {
    const originalGetUid = process.getuid;
    process.getuid = () => 1000;
    try {
      const inv = await resolveDockerInvocation(
        {
          async run(command, args) {
            if (command === "docker" && args[0] === "info") {
              return { code: 1, stdout: "", stderr: "denied" };
            }
            if (
              command === "sudo" &&
              args[0] === "-n" &&
              args[1] === "docker" &&
              args[2] === "info"
            ) {
              return { code: 0, stdout: "", stderr: "" };
            }
            return { code: 1, stdout: "", stderr: "" };
          },
        },
        { platform: "linux" },
      );
      expect(inv).toEqual({ command: "sudo", prefixArgs: ["-n", "docker"] });
    } finally {
      process.getuid = originalGetUid;
    }
  });

  it("returns invocation from ensureDocker and propagates to compose during install", async () => {
    const commands: string[] = [];
    const originalGetUid = process.getuid;
    process.getuid = () => 1000;

    try {
      const docker = await ensureDocker({
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
            return { code: 0, stdout: "", stderr: "" };
          },
        },
      });
      expect(docker.ok).toBe(true);
      if (!docker.ok) return;
      expect(docker.invocation).toEqual({ command: "sudo", prefixArgs: ["-n", "docker"] });

      const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-sudo-install-"));
      const result = await runInstall({
        dataDir,
        publicUrl: PUBLIC_URL,
        composeFile: COMPOSE_FILE,
        composeMode: "packaged",
        docker: docker.invocation,
        run: makeSudoDockerRunner(commands),
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
            return new Response(JSON.stringify({ json: { needsFirstOwner: true } }), {
              status: 200,
            });
          }
          return new Response("not found", { status: 404 });
        },
        clock: { now: () => new Date("2026-08-17T00:00:00.000Z"), sleep: async () => undefined },
        platform: "linux",
        statfs: async () => ({ bsize: 4096, bavail: 25_000_000 }),
      });

      expect(result.ok).toBe(true);
      expect(commands.some((entry) => entry.startsWith("sudo -n docker compose"))).toBe(true);
      expect(
        commands.some(
          (entry) => entry.includes("sudo -n docker") && entry.includes("quibt-migrate"),
        ),
      ).toBe(true);
    } finally {
      process.getuid = originalGetUid;
    }
  });
});

describe("install lock directory", () => {
  it("acquires an install.lock directory with metadata inside", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-lock-dir-"));
    const lock = acquireInstallLock(
      dataDir,
      555,
      new Date("2026-08-17T00:00:00.000Z"),
      () => false,
    );
    expect(lock.ok).toBe(true);
    expect(statSync(installLockPath(dataDir)).isDirectory()).toBe(true);
    expect(readInstallLock(dataDir)?.pid).toBe(555);
    releaseInstallLock(dataDir, 555);
    expect(existsSync(installLockPath(dataDir))).toBe(false);
  });

  it("lets only one concurrent stale recovery acquire the lock", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-lock-concurrent-"));
    mkdirSync(path.resolve(dataDir), { recursive: true });
    const lockDir = installLockPath(dataDir);
    mkdirSync(lockDir);
    writeFileSync(
      path.join(lockDir, "meta.json"),
      JSON.stringify({ pid: 1, startedAt: "2026-08-17T00:00:00.000Z" }),
      { mode: 0o600 },
    );

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        Promise.resolve(
          acquireInstallLock(
            dataDir,
            1000 + index,
            new Date("2026-08-17T01:00:00.000Z"),
            () => false,
          ),
        ),
      ),
    );

    const winners = results.filter((entry) => entry.ok);
    expect(winners).toHaveLength(1);
    const quarantined = readdirSync(path.resolve(dataDir)).filter((name) =>
      name.startsWith("install.lock.quarantined."),
    );
    expect(quarantined.length).toBeGreaterThanOrEqual(1);
    releaseInstallLock(dataDir, winners[0] ? (readInstallLock(dataDir)?.pid ?? -1) : -1);
  });

  it("treats recent invalid lock metadata as busy and quarantines old invalid metadata", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-lock-invalid-"));
    mkdirSync(path.resolve(dataDir), { recursive: true });
    const lockDir = installLockPath(dataDir);
    mkdirSync(lockDir);
    const metaPath = path.join(lockDir, "meta.json");
    writeFileSync(metaPath, "not-json", { mode: 0o600 });
    const recent = Date.now() - 5_000;
    const old = Date.now() - 120_000;
    const touch = (mtimeMs: number) => {
      writeFileSync(metaPath, "not-json", { mode: 0o600 });
      touchLockMetaMtime(dataDir, mtimeMs);
    };

    touch(recent);
    const busy = acquireInstallLock(dataDir, 900, new Date(), () => false, Date.now());
    expect(busy.ok).toBe(false);
    if (!busy.ok) expect(busy.message).toMatch(/already running|busy/i);

    touch(old);
    const recovered = acquireInstallLock(
      dataDir,
      901,
      new Date("2026-08-17T02:00:00.000Z"),
      () => false,
      Date.now(),
    );
    expect(recovered.ok).toBe(true);
    expect(
      readdirSync(path.resolve(dataDir)).some((name) =>
        name.startsWith("install.lock.quarantined."),
      ),
    ).toBe(true);
    releaseInstallLock(dataDir, 901);
  });
});

describe("state validation split", () => {
  const oldState = {
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
  };

  it("separates structural inspection from install release compatibility", () => {
    expect(inspectInstallStateStructure(oldState).ok).toBe(true);
    const installClassified = classifyInstallStateForInstall(oldState);
    expect(installClassified.ok).toBe(false);
    if (!installClassified.ok) expect(installClassified.reason).toBe("update_required");
    const updateClassified = classifyInstallStateForUpdate(oldState);
    expect(updateClassified.ok).toBe(true);
  });

  it("does not quarantine valid old release state during update resolution", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-old-state-"));
    const env = ensureInstallEnvironment(dataDir, PUBLIC_URL);
    writeFileSync(path.join(dataDir, "install-state.json"), `${JSON.stringify(oldState)}\n`, {
      mode: 0o600,
    });
    writeFileSync(
      env.path,
      readFileSync(env.path, "utf8").replace(
        "QUIBT_STACK_VERSION=0.2.16",
        "QUIBT_STACK_VERSION=0.1.0",
      ),
      { mode: 0o600 },
    );

    const loaded = loadInstallStateForUpdate(dataDir);
    expect(loaded?.release).toBe("0.1.0");
    expect(existsSync(installStatePath(dataDir))).toBe(true);

    const previous = resolvePreviousRelease(dataDir);
    expect(previous.ok).toBe(true);
    if (previous.ok) expect(previous.release).toBe("0.1.0");
  });

  it("keeps status read-only and never quarantines on-disk state", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-status-readonly-"));
    const env = ensureInstallEnvironment(dataDir, PUBLIC_URL);
    writeFileSync(
      path.join(dataDir, "install-state.json"),
      `${JSON.stringify({
        version: 1,
        release: "0.1.0",
        completed: ["requirements", "environment"],
        updatedAt: "2026-08-17T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      env.path,
      readFileSync(env.path, "utf8").replace(
        "QUIBT_STACK_VERSION=0.2.16",
        "QUIBT_STACK_VERSION=0.1.0",
      ),
      { mode: 0o600 },
    );

    const inspected = inspectInstallState(dataDir);
    expect(inspected.ok).toBe(false);
    if (!inspected.ok) expect(inspected.reason).toBe("update_required");
    expect(existsSync(installStatePath(dataDir))).toBe(true);

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
    expect(status.stateIssue?.reason).toBe("update_required");
    expect(existsSync(installStatePath(dataDir))).toBe(true);
    expect(loadInstallState(dataDir)).toBeNull();
    expect(existsSync(installStatePath(dataDir))).toBe(true);
  });

  it("updates from an old release when env matches exactly", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-old-update-"));
    const env = ensureInstallEnvironment(dataDir, PUBLIC_URL);
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
    writeFileSync(
      env.path,
      readFileSync(env.path, "utf8").replace(
        "QUIBT_STACK_VERSION=0.2.16",
        "QUIBT_STACK_VERSION=0.1.0",
      ),
      { mode: 0o600 },
    );

    const dump = validCustomDump();
    const result = await runUpdate({
      dataDir,
      composeFile: COMPOSE_FILE,
      // A suíte não pode depender do disco livre de quem a roda.
      statfs: async () => ({ bsize: 4096, bavail: 25_000_000 }),
      targetRelease: "0.2.16",
      run: {
        async run(command, args) {
          const joined = [command, ...args].join(" ");
          if (joined.includes("pg_dump")) {
            return { code: 0, stdout: dump.toString("latin1"), stderr: "", stdoutBytes: dump };
          }
          if (joined.includes("image inspect")) {
            return { code: 0, stdout: `${imageInspectResponse(args.at(-1) ?? "")}\n`, stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      fetch: async (url) =>
        String(url).endsWith("/ready")
          ? new Response(JSON.stringify({ ok: true }), { status: 200 })
          : new Response("down", { status: 503 }),
      clock: { now: () => new Date("2026-08-17T01:00:00.000Z"), sleep: async () => undefined },
    });

    expect(result.ok).toBe(true);
    expect(result.previousRelease).toBe("0.1.0");
    expect(result.release).toBe("0.2.16");
    expect(readFileSync(env.path, "utf8")).toMatch(/QUIBT_STACK_VERSION=0\.2\.16/);
  });
});

describe("restore cleanup warnings", () => {
  it("overrides digest-pinned services with the captured rollback tags", () => {
    const body = rollbackComposeOverride([
      { reference: "ghcr.io/quibt/quibt-stack:0.2.13", id: "sha256:stack" },
      { reference: "ghcr.io/quibt/quibt-supervisor:0.2.13", id: "sha256:supervisor" },
      { reference: "ghcr.io/quibt/quibt-computer:0.2.13", id: "sha256:computer" },
    ]);

    expect(body).toContain('image: "ghcr.io/quibt/quibt-computer:0.2.13"');
    expect(body).toContain('image: "ghcr.io/quibt/quibt-supervisor:0.2.13"');
    expect(body.match(/image: "ghcr\.io\/quibt\/quibt-stack:0\.2\.13"/g)).toHaveLength(3);
    expect(body).not.toContain("@sha256:");
  });

  it("reports completed rollback with cleanup warning when runner rejects cleanup", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-restore-reject-cleanup-"));
    ensureInstallEnvironment(dataDir, PUBLIC_URL);
    const bundle = writeBackupBundle(path.join(dataDir, "backups"), "stamp", validCustomDump());
    const envSnapshotPath = path.join(dataDir, "backups", "pre-update-stamp.env");
    writeFileSync(envSnapshotPath, readFileSync(path.join(dataDir, "quibt.env"), "utf8"), {
      mode: 0o600,
    });

    const recovery = await performCompleteRollback({
      dataDir,
      composeFile: COMPOSE_FILE,
      docker: { command: "docker", prefixArgs: [] },
      run: {
        async run(command, args) {
          const _joined = [command, ...args].join(" ");
          if (args.includes("pg_restore")) return { code: 0, stdout: "", stderr: "" };
          if (args.includes("rm")) {
            throw new Error("runner rejected cleanup");
          }
          if (args.includes(" cp ")) return { code: 0, stdout: "", stderr: "" };
          if (args.includes("tag")) return { code: 0, stdout: "", stderr: "" };
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
        release: "0.2.16",
        images: [
          { reference: "ghcr.io/quibt/quibt-stack:0.2.16", id: "sha256:id" },
          { reference: "ghcr.io/quibt/quibt-supervisor:0.2.16", id: "sha256:id" },
          { reference: "ghcr.io/quibt/quibt-computer:0.2.16", id: "sha256:id" },
        ],
        envSnapshotPath,
        backupBundleDir: bundle.dir,
        savedAt: new Date().toISOString(),
      },
      backupBundle: bundle,
      readyUrl: "http://127.0.0.1:3100/ready",
    });

    expect(recovery.status).toBe("completed");
    expect(recovery.cleanupWarning).toMatch(/runner rejected cleanup/i);
    expect(recovery.message).toMatch(/Cleanup warning/i);
    expect(recovery.completedSteps).toContain("restore-database");
  });
});
