import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type ProcessRunner, runDoctor } from "./doctor.js";
import { ensureInstallEnvironment } from "./environment.js";

const COMPOSE_FILE = path.resolve("infra/compose/docker-compose.desktop.yml");

function allServicesRunning(): string {
  return JSON.stringify([
    { Service: "postgres", State: "running", Health: "healthy" },
    { Service: "api", State: "running", Health: "healthy" },
    { Service: "web", State: "running", Health: "healthy" },
    { Service: "worker", State: "running", Health: "healthy" },
    { Service: "supervisor", State: "running", Health: "healthy" },
  ]);
}

describe("runDoctor", () => {
  it("reports docker, ports, permissions, manifest version, and service health", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-doctor-"));
    ensureInstallEnvironment(dataDir, "http://127.0.0.1:5173");

    const run: ProcessRunner = {
      async run(command, args) {
        const joined = [command, ...args].join(" ");
        if (joined.includes("docker version")) {
          return {
            code: 0,
            stdout: JSON.stringify({
              Client: { Version: "27.0.0" },
              Server: { Version: "27.0.0" },
            }),
            stderr: "",
          };
        }
        if (joined.includes("docker compose") && joined.includes(" ps ")) {
          return { code: 0, stdout: allServicesRunning(), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    const fetchImpl = async (input: string) => {
      if (String(input).endsWith("/ready")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    const report = await runDoctor({
      dataDir,
      publicUrl: "http://127.0.0.1:5173",
      composeFile: COMPOSE_FILE,
      run,
      fetch: fetchImpl,
      checkPort: async () => true,
    });

    expect(report.ok).toBe(true);
    expect(report.checks.docker?.ok).toBe(true);
    expect(report.checks.ports?.ok).toBe(true);
    expect(report.checks.permissions?.ok).toBe(true);
    expect(report.checks.manifest?.ok).toBe(true);
    expect(report.checks.health?.ok).toBe(true);
    expect(report.release).toBe("0.2.18");
    expect(JSON.stringify(report)).not.toContain("BOOTSTRAP_SECRET");
    expect(report.checks.ports?.detail).toMatchObject({ scope: "local-loopback" });
  });

  it("treats occupied local ports as healthy when Quibt endpoints respond", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-doctor-ports-"));
    ensureInstallEnvironment(dataDir, "http://127.0.0.1:5173");

    const report = await runDoctor({
      dataDir,
      publicUrl: "http://127.0.0.1:5173",
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
            return { code: 0, stdout: allServicesRunning(), stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      fetch: async (input) => {
        if (String(input).endsWith("/ready")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response("down", { status: 503 });
      },
      checkPort: async () => false,
      probeEndpoint: async () => true,
    });

    expect(report.checks.ports?.ok).toBe(true);
    expect(report.checks.health?.detail).toMatchObject({ scope: "local" });
  });

  it("flags missing docker and unhealthy api without mutating install data", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-doctor-fail-"));
    ensureInstallEnvironment(dataDir, "http://127.0.0.1:5173");

    const run: ProcessRunner = {
      async run() {
        return { code: 1, stdout: "", stderr: "docker unavailable" };
      },
    };

    const report = await runDoctor({
      dataDir,
      publicUrl: "http://127.0.0.1:5173",
      composeFile: COMPOSE_FILE,
      run,
      fetch: async () => new Response("down", { status: 503 }),
      checkPort: async () => false,
      probeEndpoint: async () => false,
    });

    expect(report.ok).toBe(false);
    expect(report.checks.docker?.ok).toBe(false);
    expect(report.checks.ports?.ok).toBe(false);
    expect(report.checks.health?.ok).toBe(false);
  });

  it("diagnoses a missing data directory without creating it", async () => {
    const missingDir = path.join(tmpdir(), `quibt-doctor-missing-${Date.now()}`);

    const report = await runDoctor({
      dataDir: missingDir,
      publicUrl: "http://127.0.0.1:5173",
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
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      fetch: async () => new Response("down", { status: 503 }),
      checkPort: async () => true,
    });

    expect(report.checks.permissions?.ok).toBe(false);
    expect(report.checks.permissions?.message).toMatch(/does not exist/i);
  });
});
