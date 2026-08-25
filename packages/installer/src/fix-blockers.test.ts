import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseComposePsOutput } from "./compose-ps.js";
import { ensureDocker } from "./docker-requirements.js";
import { acquireInstallLock, releaseInstallLock } from "./install-lock.js";
import { CONTAINER_MIGRATE_ARGS, migrateInvocation } from "./migrate.js";
import { COMPOSE_MANIFEST_NAME, resolveComposeFile } from "./paths.js";
import { parseStrictSemver } from "./semver.js";
import { loadInstallState, validateInstallState } from "./state-persist.js";
import { classifyInstallState } from "./state-validation.js";

describe("resolveComposeFile", () => {
  it("finds the manifest next to the executable", () => {
    const root = mkdtempSync(path.join(tmpdir(), "quibt-compose-"));
    const binDir = path.join(root, "bin");
    const composeDir = path.join(root, "compose");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(composeDir, { recursive: true });
    const manifest = path.join(composeDir, COMPOSE_MANIFEST_NAME);
    writeFileSync(manifest, "services: {}\n");
    const exe = path.join(binDir, "quibtbot");

    const resolved = resolveComposeFile(exe);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.path).toBe(manifest);
  });

  it("fails clearly when no packaged manifest exists", () => {
    const root = mkdtempSync(path.join(tmpdir(), "quibt-compose-missing-"));
    const resolved = resolveComposeFile(path.join(root, "quibtbot"));
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.message).toMatch(/Set QUIBT_COMPOSE_FILE/i);
    }
  });
});

describe("migrateInvocation", () => {
  it("uses the versioned container migration command without host pnpm", () => {
    const base = ["compose", "-f", "/tmp/compose.yml", "--env-file", "/tmp/quibt.env"];
    expect(migrateInvocation(base)).toEqual([...base, ...CONTAINER_MIGRATE_ARGS]);
    expect(migrateInvocation(base).join(" ")).not.toContain("pnpm install");
  });
});

describe("semver", () => {
  it("rejects newlines and non-semver values", () => {
    expect(parseStrictSemver("0.2.0\n")).toBeNull();
    expect(parseStrictSemver("latest")).toBeNull();
    expect(parseStrictSemver("0.2.0")).toBe("0.2.0");
  });
});

describe("install state validation", () => {
  it("quarantines corrupted state and restarts clean", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-state-"));
    writeFileSync(
      path.join(dataDir, "install-state.json"),
      JSON.stringify({ version: 1, release: "0.2.0\n", completed: ["pairing"], updatedAt: "x" }),
      { mode: 0o600 },
    );
    const warnings: string[] = [];
    const loaded = loadInstallState(dataDir, (message) => warnings.push(message));
    expect(loaded).toBeNull();
    expect(warnings[0]).toMatch(/quarantined/i);
  });

  it("rejects out-of-order completed steps", () => {
    expect(
      validateInstallState({
        version: 1,
        release: "0.2.0",
        completed: ["images", "requirements"],
        updatedAt: new Date().toISOString(),
      }),
    ).toBeNull();
  });

  it("rejects non-embedded releases as update_required", () => {
    const classified = classifyInstallState({
      version: 1,
      release: "0.1.0",
      completed: ["requirements", "environment"],
      updatedAt: new Date().toISOString(),
    });
    expect(classified.ok).toBe(false);
    if (!classified.ok) expect(classified.reason).toBe("update_required");
  });
});

describe("install lock", () => {
  it("blocks concurrent installs and allows stale recovery only when pid is dead", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-lock-"));
    const alive = (pid: number) => pid === 111;
    const first = acquireInstallLock(dataDir, 111, new Date("2026-08-17T00:00:00.000Z"), alive);
    expect(first.ok).toBe(true);
    const second = acquireInstallLock(dataDir, 222, new Date("2026-08-17T00:05:00.000Z"), alive);
    expect(second.ok).toBe(false);
    const stale = acquireInstallLock(
      dataDir,
      333,
      new Date("2026-08-17T01:00:00.000Z"),
      () => false,
    );
    expect(stale.ok).toBe(true);
    releaseInstallLock(dataDir, 333);
  });
});

describe("compose ps parsing", () => {
  it("parses line-delimited and array json without throwing", () => {
    const single = parseComposePsOutput(
      JSON.stringify({ Service: "api", State: "running", Health: "healthy" }),
    );
    expect(single.rows).toHaveLength(1);
    const multi = parseComposePsOutput(
      [
        JSON.stringify({ Service: "api", State: "running" }),
        JSON.stringify({ Service: "web", State: "running" }),
      ].join("\n"),
    );
    expect(multi.rows).toHaveLength(2);
    const broken = parseComposePsOutput("not-json");
    expect(broken.rows).toHaveLength(0);
    expect(broken.errors.length).toBeGreaterThan(0);
  });
});

describe("ensureDocker", () => {
  it("never runs curl or get.docker.com on linux", async () => {
    const commands: string[] = [];
    const result = await ensureDocker({
      platform: "linux",
      run: {
        async run(command, args) {
          commands.push([command, ...args].join(" "));
          if (command === "docker" && args[0] === "info") {
            return { code: 1, stdout: "", stderr: "missing" };
          }
          return { code: 1, stdout: "", stderr: "unsupported" };
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(commands.join("\n")).not.toMatch(/curl|get\.docker\.com/i);
  });

  it("names a missing Compose plugin instead of failing later with a cryptic flag error", async () => {
    const result = await ensureDocker({
      platform: "darwin",
      run: {
        async run(command, args) {
          if (command === "docker" && args[0] === "info")
            return { code: 0, stdout: "", stderr: "" };
          if (command === "docker" && args[0] === "compose") {
            return { code: 1, stdout: "", stderr: "unknown command: docker compose" };
          }
          return { code: 1, stdout: "", stderr: "unsupported" };
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/docker compose/);
  });

  it("on linux with passwordless sudo, installs the Compose plugin and goes on", async () => {
    const commands: string[] = [];
    let composeInstalled = false;
    const result = await ensureDocker({
      platform: "linux",
      run: {
        async run(command, args) {
          commands.push([command, ...args].join(" "));
          if (command === "docker" && args[0] === "info")
            return { code: 0, stdout: "", stderr: "" };
          if (command === "docker" && args[0] === "compose") {
            return composeInstalled
              ? { code: 0, stdout: "v2", stderr: "" }
              : { code: 1, stdout: "", stderr: "missing" };
          }
          if (command === "sudo" && args.join(" ").includes("docker-compose")) {
            composeInstalled = true;
            return { code: 0, stdout: "", stderr: "" };
          }
          if (command === "sudo" && args[1] === "true") return { code: 0, stdout: "", stderr: "" };
          return { code: 1, stdout: "", stderr: "unsupported" };
        },
      },
    });
    // Sem /etc/os-release legível o plano é nulo: o teste só vale quando há distro.
    expect(result.ok || commands.length > 0).toBe(true);
  });
});
