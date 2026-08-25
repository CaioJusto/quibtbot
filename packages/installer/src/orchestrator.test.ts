import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureInstallEnvironment, parseEnvFile } from "./environment.js";
import {
  finalizePairingInstall,
  type InstallerEvent,
  type ProcessRunner,
  runInstall,
  runPair,
} from "./orchestrator.js";
import { pairingContainsSensitiveData } from "./pairing.js";
import { loadInstallState } from "./state-persist.js";

const COMPOSE_FILE = path.resolve("infra/compose/docker-compose.desktop.yml");
const PUBLIC_URL = "http://127.0.0.1:5173";
const _VALID_DUMP_PREFIX = "-- PostgreSQL database dump\nSET statement_timeout = 0;\n";

function collectSecrets(envValues: Record<string, string>): string[] {
  return [
    envValues.BETTER_AUTH_SECRET,
    envValues.ENCRYPTION_KEY,
    envValues.SANDBOX_SUPERVISOR_TOKEN,
    envValues.BOOTSTRAP_SECRET,
    envValues.DATABASE_PASSWORD,
  ].filter(Boolean);
}

function assertNoSecrets(events: InstallerEvent[], secrets: string[]): void {
  for (const event of events) {
    const serialized = JSON.stringify(event);
    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain("BOOTSTRAP_SECRET=");
    expect(serialized).not.toContain("BETTER_AUTH_SECRET=");
    expect(serialized).not.toContain("DATABASE_PASSWORD=");
    expect(event.step).not.toBe("pairing-output");
  }
}

describe("runInstall resume", () => {
  it("uses complete local packaged images without contacting the registry", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-local-images-"));
    let inspectAttempts = 0;
    let pullAttempts = 0;
    const events: InstallerEvent[] = [];
    const run: ProcessRunner = {
      async run(command, args) {
        const joined = [command, ...args].join(" ");
        if (joined.includes("image inspect")) {
          inspectAttempts += 1;
          return { code: 0, stdout: `sha256:local-${inspectAttempts}\n`, stderr: "" };
        }
        if (joined.includes("docker compose") && joined.includes(" pull")) {
          pullAttempts += 1;
          return { code: 1, stdout: "", stderr: "registry must not be contacted" };
        }
        if (joined.includes("docker compose") && joined.includes(" up")) {
          return { code: 0, stdout: "started", stderr: "" };
        }
        if (joined.includes("quibt-migrate")) {
          return { code: 0, stdout: "migrate ok", stderr: "" };
        }
        if (command === "docker" && args[0] === "info") {
          return { code: 0, stdout: "Server Version: 27.0.0", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const fetchImpl = async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/ready")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith("/rpc/health") && init?.method === "POST") {
        return new Response(JSON.stringify({ json: { ok: true, needsFirstOwner: false } }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    };

    const result = await runInstall({
      dataDir,
      publicUrl: PUBLIC_URL,
      composeFile: COMPOSE_FILE,
      composeMode: "packaged",
      run,
      fetch: fetchImpl as typeof fetch,
      clock: {
        now: () => new Date("2026-08-17T00:30:00.000Z"),
        sleep: async () => undefined,
      },
      platform: "linux",
      onEvent: (event) => events.push(event),
    });

    expect(result.ok).toBe(true);
    expect(inspectAttempts).toBe(3);
    expect(pullAttempts).toBe(0);
    expect(events.some((event) => event.message.includes("already available"))).toBe(true);
  });

  it("mints packaged pairing from loopback inside the api container after host NAT is refused", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-container-pairing-"));
    const env = ensureInstallEnvironment(dataDir, PUBLIC_URL);
    writeFileSync(
      path.join(dataDir, "install-state.json"),
      `${JSON.stringify({
        version: 1,
        release: "0.2.9",
        completed: ["requirements", "environment", "images", "services", "database", "health"],
        updatedAt: "2026-08-17T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    const minted = {
      code: "LOCAL123",
      token: "container-token",
      expiresAt: "2026-08-17T01:00:00.000Z",
    };
    let containerMinted = false;
    const run: ProcessRunner = {
      async run(command, args) {
        const joined = [command, ...args].join(" ");
        expect(joined).not.toContain(env.values.BOOTSTRAP_SECRET);
        if (command === "docker" && args[0] === "info") {
          return { code: 0, stdout: "Server Version: 27.0.0", stderr: "" };
        }
        if (command === "docker" && args[0] === "compose" && args[1] === "version") {
          return { code: 0, stdout: "Docker Compose version v2.29.0", stderr: "" };
        }
        if (joined.includes("exec -T api node -e")) {
          containerMinted = true;
          return { code: 0, stdout: JSON.stringify(minted), stderr: "" };
        }
        return { code: 1, stdout: "", stderr: `unexpected command: ${joined}` };
      },
    };
    const result = await runInstall({
      dataDir,
      publicUrl: PUBLIC_URL,
      composeFile: COMPOSE_FILE,
      composeMode: "packaged",
      run,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/rpc/health") && init?.method === "POST") {
          return new Response(JSON.stringify({ json: { ok: true, needsFirstOwner: true } }), {
            status: 200,
          });
        }
        if (url.endsWith("/api/bootstrap/invites")) {
          return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch,
      clock: { now: () => new Date("2026-08-17T00:30:00.000Z"), sleep: async () => undefined },
      platform: "linux",
    });

    expect(containerMinted).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.pairing).toEqual(expect.objectContaining(minted));
  });

  it("resumes at images after a failed pull, preserves env, completes health, and returns pairing output", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-orchestrator-"));
    const env = ensureInstallEnvironment(dataDir, PUBLIC_URL);
    const secrets = collectSecrets(env.values);
    const envMtimeBefore = statSync(env.path).mtimeMs;

    let pullAttempts = 0;
    const run: ProcessRunner = {
      async run(command, args) {
        const joined = [command, ...args].join(" ");
        if (joined.includes("docker compose") && joined.includes(" pull")) {
          pullAttempts += 1;
          if (pullAttempts === 1) {
            return { code: 1, stdout: "", stderr: "pull failed" };
          }
        }
        if (joined.includes("docker compose") && joined.includes(" up")) {
          return { code: 0, stdout: "started", stderr: "" };
        }
        if (joined.includes("quibt-migrate")) {
          return { code: 0, stdout: "migrate ok", stderr: "" };
        }
        if (command === "docker" && args[0] === "info") {
          return { code: 0, stdout: "Server Version: 27.0.0", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    const minted = {
      code: "ABCD1234",
      token: "invite-token-opaque",
      expiresAt: "2026-08-17T01:00:00.000Z",
    };

    const fetchImpl = async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/ready")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith("/api/bootstrap/invites") && init?.method === "POST") {
        return new Response(JSON.stringify(minted), { status: 200 });
      }
      if (url.endsWith("/rpc/health") && init?.method === "POST") {
        return new Response(JSON.stringify({ json: { ok: true, needsFirstOwner: true } }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    };

    const clock = {
      now: () => new Date("2026-08-17T00:30:00.000Z"),
      sleep: async () => undefined,
    };

    const firstEvents: InstallerEvent[] = [];
    const first = await runInstall({
      dataDir,
      publicUrl: PUBLIC_URL,
      composeFile: COMPOSE_FILE,
      composeMode: "packaged",
      run,
      fetch: fetchImpl,
      clock,
      platform: "linux",
      onEvent: (event) => firstEvents.push(event),
    });

    expect(first.ok).toBe(false);
    expect(pullAttempts).toBe(1);
    expect(loadInstallState(dataDir)?.completed).toEqual(["requirements", "environment"]);
    expect(statSync(env.path).mtimeMs).toBe(envMtimeBefore);
    assertNoSecrets(firstEvents, secrets);

    const secondEvents: InstallerEvent[] = [];
    const second = await runInstall({
      dataDir,
      publicUrl: PUBLIC_URL,
      composeFile: COMPOSE_FILE,
      composeMode: "packaged",
      run,
      fetch: fetchImpl,
      clock,
      platform: "linux",
      onEvent: (event) => secondEvents.push(event),
    });

    expect(second.ok).toBe(true);
    expect(second.pairingPending).toBe(true);
    expect(second.pairing).toEqual(
      expect.objectContaining({
        url: PUBLIC_URL,
        code: minted.code,
        token: minted.token,
        expiresAt: minted.expiresAt,
      }),
    );
    expect(second.pairing?.deepLink).toContain(minted.token);
    expect(second.pairing?.deepLink).toContain("quibt://bootstrap?");
    expect(second.pairing?.qrSvg).toContain("<svg");
    for (const event of secondEvents) {
      expect(pairingContainsSensitiveData(second.pairing!, JSON.stringify(event))).toBe(false);
    }
    assertNoSecrets(secondEvents, secrets);
    await finalizePairingInstall(dataDir, clock);
    expect(loadInstallState(dataDir)?.completed).toContain("pairing");
  });

  it("completes successfully with claimed instruction when deployment already has an owner", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-orchestrator-claimed-"));
    ensureInstallEnvironment(dataDir, PUBLIC_URL);
    writeFileSync(
      path.join(dataDir, "install-state.json"),
      `${JSON.stringify({
        version: 1,
        release: "0.2.9",
        completed: ["requirements", "environment", "images", "services", "database", "health"],
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
        async run(command, args) {
          if (command === "docker" && args[0] === "info") {
            return { code: 0, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      fetch: async (input, init) => {
        if (String(input).endsWith("/rpc/health") && init?.method === "POST") {
          return new Response(JSON.stringify({ json: { ok: true, needsFirstOwner: false } }), {
            status: 200,
          });
        }
        return new Response("not found", { status: 404 });
      },
      clock: { now: () => new Date(), sleep: async () => undefined },
      platform: "linux",
    });

    expect(result.ok).toBe(true);
    expect(result.pairing).toBeUndefined();
    expect(result.claimedInstruction).toMatch(/authenticated client/i);
    expect(loadInstallState(dataDir)?.completed).toContain("pairing");
  });

  it("reissues packaged owner pairing inside the API container after a host-loopback 404", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-pair-recovery-"));
    const env = ensureInstallEnvironment(dataDir, PUBLIC_URL);
    const minted = {
      code: "RECOVER1",
      token: "fresh-invite-token",
      expiresAt: "2026-08-17T22:10:00.000Z",
    };
    const run: ProcessRunner = {
      async run(command, args) {
        const joined = [command, ...args].join(" ");
        expect(joined).not.toContain(env.values.BOOTSTRAP_SECRET);
        if (joined.includes("exec -T api node -e")) {
          return { code: 0, stdout: JSON.stringify(minted), stderr: "" };
        }
        return { code: 1, stdout: "", stderr: `unexpected command: ${joined}` };
      },
    };
    const result = await runPair({
      dataDir,
      publicUrl: PUBLIC_URL,
      composeFile: COMPOSE_FILE,
      composeMode: "packaged",
      docker: { command: "docker", prefixArgs: [] },
      run,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/rpc/health") && init?.method === "POST") {
          return new Response(JSON.stringify({ json: { ok: true, needsFirstOwner: true } }), {
            status: 200,
          });
        }
        if (url.endsWith("/api/bootstrap/invites")) {
          return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch,
    });

    expect(result).toEqual({
      ok: true,
      pairing: expect.objectContaining(minted),
    });
  });
});

describe("instalação pública (sslip.io + Caddy)", () => {
  it("numa VPS limpa grava o https no env, sobe o Caddy e entrega esse endereço ao celular", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-public-"));
    const composeCalls: string[] = [];
    const run: ProcessRunner = {
      async run(command, args) {
        const joined = [command, ...args].join(" ");
        if (joined.includes("docker compose")) composeCalls.push(joined);
        if (joined.includes("quibt-migrate")) return { code: 0, stdout: "migrate ok", stderr: "" };
        if (command === "docker" && args[0] === "info") {
          return { code: 0, stdout: "Server Version: 27.0.0", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const minted = {
      code: "ABCD1234",
      token: "invite-token",
      expiresAt: "2026-08-17T01:00:00.000Z",
    };
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.ipify.org") return new Response("31.97.86.113", { status: 200 });
      if (url.endsWith("/ready"))
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.endsWith("/api/bootstrap/invites") && init?.method === "POST") {
        return new Response(JSON.stringify(minted), { status: 200 });
      }
      if (url.endsWith("/rpc/health")) {
        return new Response(JSON.stringify({ json: { ok: true, needsFirstOwner: true } }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const events: InstallerEvent[] = [];

    const result = await runInstall({
      dataDir,
      publicUrl: PUBLIC_URL,
      composeFile: COMPOSE_FILE,
      composeMode: "packaged",
      run,
      fetch: fetchImpl,
      clock: { now: () => new Date("2026-08-17T00:30:00.000Z"), sleep: async () => undefined },
      platform: "linux",
      publicAccess: {
        fetch: fetchImpl,
        checkPort: async () => true,
        random: () => Buffer.from("deadbeef", "hex"),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.ok).toBe(true);
    const host = "quibt-deadbeef.31.97.86.113.sslip.io";
    // O env é a fonte de verdade das origens: Better Auth e web precisam do https.
    const env = parseEnvFile(readFileSync(path.join(dataDir, "quibt.env"), "utf8"));
    expect(env.QUIBT_PUBLIC_HOST).toBe(host);
    expect(env.WEB_ORIGIN).toBe(`https://${host}`);
    expect(env.BETTER_AUTH_URL).toBe(`https://${host}`);
    expect(env.API_URL).toBe(`https://${host}`);
    // Só o Caddy encara a internet; web e API ficam presos no host.
    expect(env.QUIBT_WEB_BIND_HOST).toBe("127.0.0.1");
    expect(env.QUIBT_API_BIND_HOST).toBe("127.0.0.1");
    // O up dos apps liga o profile e inclui o caddy.
    const appsUp = composeCalls.find((call) => call.includes(" up ") && call.includes("caddy"));
    expect(appsUp).toContain("--profile public");
    // O celular recebe o https, nunca o loopback.
    expect(result.pairing?.url).toBe(`https://${host}`);
    expect(events.map((event) => event.message)).toContainEqual(
      expect.stringContaining(`Endereço público: https://${host}`),
    );
  });

  it("com 80/443 ocupadas fica local, diz a porta, e não liga o profile", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-public-busy-"));
    const composeCalls: string[] = [];
    const run: ProcessRunner = {
      async run(command, args) {
        const joined = [command, ...args].join(" ");
        if (joined.includes("docker compose")) composeCalls.push(joined);
        if (joined.includes("quibt-migrate")) return { code: 0, stdout: "migrate ok", stderr: "" };
        if (command === "docker" && args[0] === "info") {
          return { code: 0, stdout: "Server Version: 27.0.0", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.ipify.org") return new Response("31.97.86.113", { status: 200 });
      if (url.endsWith("/ready"))
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.endsWith("/api/bootstrap/invites") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ code: "X", token: "t", expiresAt: "2026-08-17T01:00:00.000Z" }),
          { status: 200 },
        );
      }
      if (url.endsWith("/rpc/health")) {
        return new Response(JSON.stringify({ json: { ok: true, needsFirstOwner: true } }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const events: InstallerEvent[] = [];

    const result = await runInstall({
      dataDir,
      publicUrl: PUBLIC_URL,
      composeFile: COMPOSE_FILE,
      composeMode: "packaged",
      run,
      fetch: fetchImpl,
      clock: { now: () => new Date("2026-08-17T00:30:00.000Z"), sleep: async () => undefined },
      platform: "linux",
      publicAccess: { fetch: fetchImpl, checkPort: async (port) => port !== 80 },
      onEvent: (event) => events.push(event),
    });

    expect(result.ok).toBe(true);
    const env = parseEnvFile(readFileSync(path.join(dataDir, "quibt.env"), "utf8"));
    expect(env.QUIBT_PUBLIC_HOST).toBeUndefined();
    expect(env.WEB_ORIGIN).toBe(PUBLIC_URL);
    expect(composeCalls.some((call) => call.includes("--profile public"))).toBe(false);
    expect(result.pairing?.url).toBe(PUBLIC_URL);
    expect(events.map((event) => event.message)).toContainEqual(expect.stringMatching(/porta 80/));
  });
});

describe("retomada numa instalação pública", () => {
  it("o pairing entrega o https do Caddy mesmo quando o passo environment foi pulado", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-public-resume-"));
    // Primeira passada já gravou o host público; o install caiu depois e voltou.
    const env = ensureInstallEnvironment(dataDir, PUBLIC_URL, {
      publicHost: "quibt-348dc227.46.224.84.18.sslip.io",
    });
    expect(env.values.QUIBT_PUBLIC_HOST).toBe("quibt-348dc227.46.224.84.18.sslip.io");
    writeFileSync(
      path.join(dataDir, "install-state.json"),
      `${JSON.stringify({
        version: 1,
        release: "0.2.9",
        completed: ["requirements", "environment", "images", "services", "database"],
        updatedAt: "2026-08-17T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    const run: ProcessRunner = {
      async run(command, args) {
        if (command === "docker" && args[0] === "info") {
          return { code: 0, stdout: "Server Version: 27.0.0", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const minted = {
      code: "ABCD1234",
      token: "invite-token",
      expiresAt: "2026-08-17T01:00:00.000Z",
    };
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      const url = String(input);
      // Sonda de saúde no loopback, nunca no https (o Caddy pode nem estar de pé).
      if (url === "http://127.0.0.1:3100/ready")
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.endsWith("/api/bootstrap/invites") && init?.method === "POST") {
        return new Response(JSON.stringify(minted), { status: 200 });
      }
      if (url.endsWith("/rpc/health")) {
        return new Response(JSON.stringify({ json: { ok: true, needsFirstOwner: true } }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await runInstall({
      dataDir,
      publicUrl: PUBLIC_URL,
      composeFile: COMPOSE_FILE,
      composeMode: "packaged",
      run,
      fetch: fetchImpl,
      clock: { now: () => new Date("2026-08-17T00:30:00.000Z"), sleep: async () => undefined },
      platform: "linux",
      // Sem publicAccess de propósito: a retomada não redescobre nada — lê o env.
    });

    expect(result.ok).toBe(true);
    expect(result.pairing?.url).toBe("https://quibt-348dc227.46.224.84.18.sslip.io");
    expect(result.pairing?.deepLink).toContain(
      encodeURIComponent("https://quibt-348dc227.46.224.84.18.sslip.io"),
    );
  });
});
