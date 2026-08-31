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
/** Disco de sobra: a suíte não pode depender do quanto a máquina de quem roda tem livre. */
const plentyOfDisk = async () => ({ bsize: 4096, bavail: 25_000_000 });
const COMPOSE_IMAGES = [
  "postgres:16@sha256:e17e86066e5ef83e0952a9347f5c792b7ece00972e2aa787a6986f471b3dd3d5",
  "ghcr.io/quibt/quibt-computer:0.2.18",
  "ghcr.io/quibt/quibt-supervisor:0.2.18",
  "ghcr.io/quibt/quibt-stack:0.2.18",
];

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
    expect(events.some((event) => event.message.includes("nada para baixar"))).toBe(true);
  });

  it("mints packaged pairing from loopback inside the api container after host NAT is refused", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-container-pairing-"));
    const env = ensureInstallEnvironment(dataDir, PUBLIC_URL);
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
    let firstRun = true;
    const run: ProcessRunner = {
      async run(command, args) {
        const joined = [command, ...args].join(" ");
        if (joined.includes("docker compose") && joined.includes(" config --images")) {
          return { code: 0, stdout: `${COMPOSE_IMAGES.join("\n")}\n`, stderr: "" };
        }
        if (command === "docker" && args[0] === "pull") {
          pullAttempts += 1;
          // Na primeira passada a rede cai de vez: as três tentativas falham.
          if (firstRun) return { code: 1, stdout: "", stderr: "pull failed: i/o timeout" };
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
      statfs: plentyOfDisk,
      onEvent: (event) => firstEvents.push(event),
    });

    expect(first.ok).toBe(false);
    // Três tentativas na mesma imagem antes de desistir; a frase diz que dá para voltar.
    expect(pullAttempts).toBe(3);
    expect(first.error).toContain("falhou 3 vezes");
    expect(first.error).toContain("o que já baixou fica guardado");
    expect(first.errorDetail).toContain("pull failed");
    expect(firstEvents.map((event) => event.message)).toContainEqual(
      expect.stringContaining("tentativa 1 de 3"),
    );
    expect(loadInstallState(dataDir)?.completed).toEqual(["requirements", "environment"]);
    expect(statSync(env.path).mtimeMs).toBe(envMtimeBefore);
    assertNoSecrets(firstEvents, secrets);

    firstRun = false;
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
      statfs: plentyOfDisk,
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
        release: "0.2.18",
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
      statfs: plentyOfDisk,
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
      statfs: plentyOfDisk,
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
        release: "0.2.18",
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

describe("quibtbot pair numa VPS", () => {
  it("cai para o mint dentro do container quando o loopback do host devolve 404", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-pair-vps-"));
    ensureInstallEnvironment(dataDir, PUBLIC_URL, {
      publicHost: "quibt-4d2a48dc.46.224.84.18.sslip.io",
    });
    // Pelo docker-proxy o par não é loopback: a API esconde a rota como 404.
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/bootstrap/invites") && init?.method === "POST") {
        return new Response("Not found", { status: 404 });
      }
      if (url.endsWith("/rpc/health")) {
        return new Response(JSON.stringify({ json: { ok: true, needsFirstOwner: true } }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    let execMinted = false;
    const run: ProcessRunner = {
      async run(command, args) {
        const joined = [command, ...args].join(" ");
        if (command === "docker" && args[0] === "info") {
          return { code: 0, stdout: "Server Version: 27.0.0", stderr: "" };
        }
        if (joined.includes("exec") && joined.includes("api")) {
          execMinted = true;
          return {
            code: 0,
            stdout: JSON.stringify({
              code: "VPS12345",
              token: "t",
              expiresAt: "2026-08-17T01:00:00.000Z",
            }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    const result = await runPair({
      dataDir,
      publicUrl: PUBLIC_URL,
      fetch: fetchImpl,
      composeMode: "packaged",
      composeFile: COMPOSE_FILE,
      run,
      platform: "linux",
    });

    expect(result.ok).toBe(true);
    expect(execMinted).toBe(true);
    if (result.ok) {
      expect(result.pairing.code).toBe("VPS12345");
      // E o celular recebe o https, não o loopback.
      expect(result.pairing.url).toBe("https://quibt-4d2a48dc.46.224.84.18.sslip.io");
    }
  });
});

/** Estado até `environment`: a próxima passada começa no download das imagens. */
function writeStateBeforeImages(dataDir: string): void {
  writeFileSync(
    path.join(dataDir, "install-state.json"),
    `${JSON.stringify({
      version: 1,
      release: "0.2.18",
      completed: ["requirements", "environment"],
      updatedAt: "2026-08-17T00:00:00.000Z",
    })}\n`,
    { mode: 0o600 },
  );
}

const clockNow = { now: () => new Date("2026-08-17T00:30:00.000Z"), sleep: async () => undefined };

describe("download das imagens com progresso", () => {
  it("avisa o tamanho, puxa uma imagem por vez e emite camadas feitas/total", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-pull-progress-"));
    ensureInstallEnvironment(dataDir, PUBLIC_URL);
    writeStateBeforeImages(dataDir);
    const pulled: string[] = [];
    const run: ProcessRunner = {
      async run(command, args, options) {
        const joined = [command, ...args].join(" ");
        if (command === "docker" && args[0] === "info") {
          return { code: 0, stdout: "/var/lib/docker\n", stderr: "" };
        }
        if (joined.includes(" config --images")) {
          return { code: 0, stdout: `${COMPOSE_IMAGES.join("\n")}\n`, stderr: "" };
        }
        if (command === "docker" && args[0] === "pull") {
          pulled.push(args[1] as string);
          options?.onOutput?.("aaaaaaaaaaaa: Pulling fs layer", "stdout");
          options?.onOutput?.("bbbbbbbbbbbb: Pulling fs layer", "stdout");
          options?.onOutput?.("aaaaaaaaaaaa: Pull complete", "stdout");
          options?.onOutput?.("bbbbbbbbbbbb: Pull complete", "stdout");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (joined.includes("quibt-migrate")) return { code: 0, stdout: "migrate ok", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const events: InstallerEvent[] = [];
    const result = await runInstall({
      dataDir,
      publicUrl: PUBLIC_URL,
      composeFile: COMPOSE_FILE,
      composeMode: "packaged",
      run,
      fetch: (async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/ready")) return new Response("{}", { status: 200 });
        if (url.endsWith("/rpc/health") && init?.method === "POST") {
          return new Response(JSON.stringify({ json: { ok: true, needsFirstOwner: false } }), {
            status: 200,
          });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch,
      clock: clockNow,
      platform: "linux",
      statfs: plentyOfDisk,
      onEvent: (event) => events.push(event),
    });

    expect(result.ok).toBe(true);
    expect(pulled).toEqual(COMPOSE_IMAGES);
    const messages = events.map((event) => event.message);
    expect(messages).toContainEqual(expect.stringContaining("Vou baixar cerca de 1,7 GB"));
    const progress = events.filter((event) => event.progress).map((event) => event.progress);
    expect(progress[0]).toEqual({
      image: COMPOSE_IMAGES[0],
      // O rótulo já vem curto: a referência crua tem 80 caracteres e quebra a barra.
      label: "postgres:16@e17e86066e5e",
      index: 1,
      count: 4,
      layersDone: 0,
      layersTotal: 0,
    });
    expect(progress).toContainEqual({
      image: "ghcr.io/quibt/quibt-stack:0.2.18",
      label: "quibt-stack:0.2.18",
      index: 4,
      count: 4,
      layersDone: 1,
      layersTotal: 2,
    });
    expect(messages).toContain("Baixando imagem 4 de 4: quibt-stack:0.2.18 — 1/2 camadas");
    // O passo continuou e o estado gravou o download.
    expect(loadInstallState(dataDir)?.completed).toContain("images");
  });

  it("download que fica mudo é refeito; depois de três vezes falha com a causa", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-pull-idle-"));
    ensureInstallEnvironment(dataDir, PUBLIC_URL);
    writeStateBeforeImages(dataDir);
    const pullOptions: Array<{ inactivityTimeoutMs?: number; timeoutMs?: number }> = [];
    const run: ProcessRunner = {
      async run(command, args, options) {
        const joined = [command, ...args].join(" ");
        if (command === "docker" && args[0] === "info") return { code: 0, stdout: "", stderr: "" };
        if (joined.includes(" config --images")) {
          return { code: 0, stdout: `${COMPOSE_IMAGES.join("\n")}\n`, stderr: "" };
        }
        if (command === "docker" && args[0] === "pull") {
          pullOptions.push(options ?? {});
          return {
            code: 124,
            stdout: "",
            stderr: "process produced no output for 180 s",
            timedOut: "inactivity",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const events: InstallerEvent[] = [];
    const result = await runInstall({
      dataDir,
      publicUrl: PUBLIC_URL,
      composeFile: COMPOSE_FILE,
      composeMode: "packaged",
      run,
      fetch: (async () => new Response("not found", { status: 404 })) as typeof fetch,
      clock: clockNow,
      platform: "linux",
      statfs: plentyOfDisk,
      onEvent: (event) => events.push(event),
    });

    expect(result.ok).toBe(false);
    expect(pullOptions).toHaveLength(3);
    for (const options of pullOptions) {
      expect(options.inactivityTimeoutMs).toBe(900_000);
      expect(options.timeoutMs).toBe(60 * 60_000);
    }
    expect(result.error).toContain("ficou 15 minutos sem progresso");
    expect(result.error).toContain("falhou 3 vezes");
    const failed = events.find((event) => event.status === "failed");
    expect(failed?.step).toBe("images");
    expect(failed?.detail).toEqual({ stderr: "process produced no output for 180 s" });
    expect(loadInstallState(dataDir)?.completed).toEqual(["requirements", "environment"]);
  });

  it("na retomada baixa só o que falta e não cobra os 10 GB de novo", async () => {
    // A rede caiu na última imagem: as outras três já ocupam a maior parte dos 10 GB, e
    // exigir os 10 GB de novo trancava quem a mensagem anterior mandou tentar outra vez.
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-pull-resume-"));
    ensureInstallEnvironment(dataDir, PUBLIC_URL);
    writeStateBeforeImages(dataDir);
    const pulled: string[] = [];
    const run: ProcessRunner = {
      async run(command, args, options) {
        const joined = [command, ...args].join(" ");
        if (joined.includes("image inspect")) {
          const reference = args.at(-1) as string;
          return reference.includes("quibt-stack")
            ? { code: 1, stdout: "", stderr: "Error: No such image" }
            : { code: 0, stdout: "sha256:local\n", stderr: "" };
        }
        if (command === "docker" && args[0] === "info") {
          return { code: 0, stdout: "/var/lib/docker\n", stderr: "" };
        }
        if (joined.includes(" config --images")) {
          return { code: 0, stdout: `${COMPOSE_IMAGES.join("\n")}\n`, stderr: "" };
        }
        if (command === "docker" && args[0] === "pull") {
          pulled.push(args[1] as string);
          options?.onOutput?.("aaaaaaaaaaaa: Pulling fs layer", "stdout");
          options?.onOutput?.("aaaaaaaaaaaa: Pull complete", "stdout");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (joined.includes("quibt-migrate")) return { code: 0, stdout: "migrate ok", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const events: InstallerEvent[] = [];
    const result = await runInstall({
      dataDir,
      publicUrl: PUBLIC_URL,
      composeFile: COMPOSE_FILE,
      composeMode: "packaged",
      run,
      fetch: (async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/ready")) return new Response("{}", { status: 200 });
        if (url.endsWith("/rpc/health") && init?.method === "POST") {
          return new Response(JSON.stringify({ json: { ok: true, needsFirstOwner: false } }), {
            status: 200,
          });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch,
      clock: clockNow,
      platform: "linux",
      // 3,1 GB livres: passa para uma imagem, reprovaria nos 10 GB do começo.
      statfs: async () => ({ bsize: 4096, bavail: 750_000 }),
      onEvent: (event) => events.push(event),
    });

    expect(result.ok).toBe(true);
    expect(pulled).toEqual(["ghcr.io/quibt/quibt-stack:0.2.18"]);
    const messages = events.map((event) => event.message);
    expect(messages).toContainEqual(
      "Falta 1 imagem de 4 (cerca de 0,4 GB). O resto já está no disco.",
    );
    expect(messages).not.toContainEqual(expect.stringContaining("Vou baixar cerca de 1,7 GB"));
    // Uma só imagem para baixar: o "imagem N de M" conta o que falta, não o que já veio.
    const progress = events.filter((event) => event.progress).map((event) => event.progress);
    expect(progress.every((entry) => entry?.count === 1)).toBe(true);
  });

  it("sem 10 GB livres falha antes de baixar, dizendo quanto falta e onde", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-pull-disk-"));
    ensureInstallEnvironment(dataDir, PUBLIC_URL);
    writeStateBeforeImages(dataDir);
    let pulls = 0;
    const measured: string[] = [];
    const run: ProcessRunner = {
      async run(command, args) {
        if (command === "docker" && args[0] === "info" && args[1] === "--format") {
          return { code: 0, stdout: "/var/lib/docker\n", stderr: "" };
        }
        if (command === "docker" && args[0] === "info") return { code: 0, stdout: "", stderr: "" };
        if (args[0] === "pull") pulls += 1;
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const events: InstallerEvent[] = [];
    const result = await runInstall({
      dataDir,
      publicUrl: PUBLIC_URL,
      composeFile: COMPOSE_FILE,
      composeMode: "packaged",
      run,
      fetch: (async () => new Response("not found", { status: 404 })) as typeof fetch,
      clock: clockNow,
      platform: "linux",
      statfs: async (target) => {
        measured.push(target);
        if (target === "/var/lib/docker") return { bsize: 4096, bavail: 500_000 }; // 2 GB
        return { bsize: 4096, bavail: 25_000_000 };
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.ok).toBe(false);
    expect(pulls).toBe(0);
    expect(measured).toEqual([path.resolve(dataDir), "/var/lib/docker"]);
    expect(result.error).toContain("Faltam 8 GB em /var/lib/docker");
    expect(events.at(-1)).toMatchObject({ step: "images", status: "failed" });
  });
});

describe("já instalado = ligar", () => {
  function completeState(dataDir: string): void {
    writeFileSync(
      path.join(dataDir, "install-state.json"),
      `${JSON.stringify({
        version: 1,
        release: "0.2.18",
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
  }

  it("com o estado completo religa o stack, espera a API e devolve o endereço", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-start-"));
    ensureInstallEnvironment(dataDir, PUBLIC_URL);
    completeState(dataDir);
    const composeCalls: string[] = [];
    const readyProbes: string[] = [];
    const run: ProcessRunner = {
      async run(command, args, options) {
        const joined = [command, ...args].join(" ");
        if (command === "docker" && args[0] === "info") {
          return { code: 0, stdout: "Server Version: 27.0.0", stderr: "" };
        }
        // As imagens continuam no disco desde a instalação.
        if (joined.includes("image inspect")) {
          return { code: 0, stdout: "sha256:local\n", stderr: "" };
        }
        if (joined.includes("docker compose")) {
          composeCalls.push(`${joined} [timeout ${options?.timeoutMs}]`);
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: `unexpected: ${joined}` };
      },
    };
    const events: InstallerEvent[] = [];
    const result = await runInstall({
      dataDir,
      publicUrl: PUBLIC_URL,
      composeFile: COMPOSE_FILE,
      composeMode: "packaged",
      run,
      fetch: (async (input: string) => {
        readyProbes.push(String(input));
        return String(input).endsWith("/ready")
          ? new Response("{}", { status: 200 })
          : new Response("not found", { status: 404 });
      }) as typeof fetch,
      clock: clockNow,
      platform: "linux",
      onEvent: (event) => events.push(event),
    });

    expect(result.ok).toBe(true);
    expect(result.alreadyInstalled).toBe(true);
    expect(result.url).toBe(PUBLIC_URL);
    expect(result.servicesStarted).toBe(true);
    expect(result.pairing).toBeUndefined();
    // Um único `up` com os serviços explícitos; a sondagem HTTP é o health gate. Sem
    // `--wait`, porque `computer` é intencionalmente one-shot.
    const ups = composeCalls.filter((call) => call.includes(" up "));
    expect(ups).toHaveLength(1);
    expect(ups[0]).toMatch(/ up -d supervisor api worker web computer \[timeout 600000\]$/);
    expect(ups[0]).not.toContain("--profile");
    expect(composeCalls.some((call) => call.includes(" pull") || call.includes("migrate"))).toBe(
      false,
    );
    expect(readyProbes).toEqual(["http://127.0.0.1:3100/ready"]);
    const messages = events.map((event) => event.message);
    expect(messages).toContain("Ligando o Quibt Bot…");
    expect(messages).toContain(`No ar em ${PUBLIC_URL}`);
    expect(events.at(-1)).toMatchObject({ step: "health", status: "succeeded" });
    // O estado continua completo: nada foi reinstalado.
    expect(loadInstallState(dataDir)?.completed).toContain("pairing");
  });

  it("numa instalação pública liga o profile do Caddy e entrega o https", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-start-public-"));
    ensureInstallEnvironment(dataDir, PUBLIC_URL, {
      publicHost: "quibt-deadbeef.31.97.86.113.sslip.io",
    });
    completeState(dataDir);
    const composeCalls: string[] = [];
    const result = await runInstall({
      dataDir,
      publicUrl: PUBLIC_URL,
      composeFile: COMPOSE_FILE,
      composeMode: "packaged",
      run: {
        async run(command, args) {
          const joined = [command, ...args].join(" ");
          if (joined.includes("image inspect")) {
            return { code: 0, stdout: "sha256:local\n", stderr: "" };
          }
          if (joined.includes("docker compose")) composeCalls.push(joined);
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      fetch: (async (input: string) =>
        String(input) === "http://127.0.0.1:3100/ready"
          ? new Response("{}", { status: 200 })
          : new Response("not found", { status: 404 })) as typeof fetch,
      clock: clockNow,
      platform: "linux",
    });
    expect(result.ok).toBe(true);
    expect(result.url).toBe("https://quibt-deadbeef.31.97.86.113.sslip.io");
    expect(composeCalls.find((call) => call.includes(" up "))).toContain("--profile public");
  });

  it("no Mac com o Docker Desktop fechado abre a baleia, espera e só então liga", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-start-mac-"));
    ensureInstallEnvironment(dataDir, PUBLIC_URL);
    completeState(dataDir);
    const commands: string[] = [];
    let opened = false;
    const DOCKER_CLI = "/Applications/Docker.app/Contents/Resources/bin/docker";
    const run: ProcessRunner = {
      async run(command, args) {
        const joined = [command, ...args].join(" ");
        commands.push(joined);
        if (command === "/usr/bin/test") return { code: 0, stdout: "", stderr: "" };
        if (command === "/usr/bin/open") {
          opened = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === DOCKER_CLI && joined.includes("image inspect")) {
          return { code: 0, stdout: "sha256:local\n", stderr: "" };
        }
        if (command === DOCKER_CLI && opened) return { code: 0, stdout: "", stderr: "" };
        return { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
      },
    };
    const events: InstallerEvent[] = [];
    const result = await runInstall({
      dataDir,
      publicUrl: PUBLIC_URL,
      composeFile: COMPOSE_FILE,
      composeMode: "packaged",
      run,
      fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch,
      clock: clockNow,
      platform: "darwin",
      onEvent: (event) => events.push(event),
    });

    expect(result.ok).toBe(true);
    expect(result.alreadyInstalled).toBe(true);
    expect(commands).toContain("/usr/bin/open -g /Applications/Docker.app");
    expect(
      commands.some(
        (entry) =>
          entry.startsWith(`${DOCKER_CLI} compose`) &&
          entry.includes(" up -d supervisor api worker web computer"),
      ),
    ).toBe(true);
    expect(events.map((event) => event.message)).toContain("Abrindo o Docker Desktop…");
  });

  it("se o up falhar, a frase é para gente e o stderr fica nos detalhes", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-start-fail-"));
    ensureInstallEnvironment(dataDir, PUBLIC_URL);
    completeState(dataDir);
    const events: InstallerEvent[] = [];
    const result = await runInstall({
      dataDir,
      publicUrl: PUBLIC_URL,
      composeFile: COMPOSE_FILE,
      composeMode: "packaged",
      run: {
        async run(command, args) {
          const joined = [command, ...args].join(" ");
          if (joined.includes("image inspect")) {
            return { code: 0, stdout: "sha256:local\n", stderr: "" };
          }
          if (joined.includes(" up ")) {
            return {
              code: 1,
              stdout: "",
              stderr: "Bind for 127.0.0.1:5173 failed: port is already allocated",
            };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch,
      clock: clockNow,
      platform: "linux",
      onEvent: (event) => events.push(event),
    });
    expect(result.ok).toBe(false);
    expect(result.servicesStarted).toBeUndefined();
    expect(result.error).toContain("A porta 5173 já está em uso");
    expect(result.errorDetail).toContain("port is already allocated");
    expect(events.at(-1)).toMatchObject({
      step: "services",
      status: "failed",
      detail: { stderr: expect.stringContaining("port is already allocated") },
    });
  });

  it("com as imagens apagadas baixa de novo, com progresso, antes de ligar", async () => {
    // "Clean / Purge data" no Docker Desktop ou `docker system prune -a`: o estado
    // continua completo, mas o `up --wait` teria de baixar 1,7 GB calado.
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-start-no-images-"));
    ensureInstallEnvironment(dataDir, PUBLIC_URL);
    completeState(dataDir);
    const order: string[] = [];
    const pulled: string[] = [];
    const run: ProcessRunner = {
      async run(command, args, options) {
        const joined = [command, ...args].join(" ");
        if (joined.includes("image inspect")) {
          return { code: 1, stdout: "", stderr: "Error: No such image" };
        }
        if (command === "docker" && args[0] === "info") {
          return { code: 0, stdout: "/var/lib/docker\n", stderr: "" };
        }
        if (joined.includes(" config --images")) {
          return { code: 0, stdout: `${COMPOSE_IMAGES.join("\n")}\n`, stderr: "" };
        }
        if (command === "docker" && args[0] === "pull") {
          order.push("pull");
          pulled.push(args[1] as string);
          options?.onOutput?.("aaaaaaaaaaaa: Pulling fs layer", "stdout");
          options?.onOutput?.("aaaaaaaaaaaa: Pull complete", "stdout");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (joined.includes(" up ")) {
          order.push("up");
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const events: InstallerEvent[] = [];
    const result = await runInstall({
      dataDir,
      publicUrl: PUBLIC_URL,
      composeFile: COMPOSE_FILE,
      composeMode: "packaged",
      run,
      fetch: (async (input: string) =>
        String(input).endsWith("/ready")
          ? new Response("{}", { status: 200 })
          : new Response("not found", { status: 404 })) as typeof fetch,
      clock: clockNow,
      platform: "linux",
      statfs: plentyOfDisk,
      onEvent: (event) => events.push(event),
    });

    expect(result.ok).toBe(true);
    expect(result.alreadyInstalled).toBe(true);
    expect(pulled).toEqual(COMPOSE_IMAGES);
    // Baixar primeiro, ligar depois: o `up --wait` não vira um download mudo.
    expect(order.at(0)).toBe("pull");
    expect(order.at(-1)).toBe("up");
    expect(events.some((event) => event.step === "images" && event.progress)).toBe(true);
    expect(events.map((event) => event.message)).toContainEqual(
      expect.stringContaining("Vou baixar cerca de 1,7 GB"),
    );
  });

  it("no Mac sem o Docker Desktop não baixa nada nem pede a senha", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-start-no-docker-"));
    ensureInstallEnvironment(dataDir, PUBLIC_URL);
    completeState(dataDir);
    const commands: string[] = [];
    const run: ProcessRunner = {
      async run(command, args) {
        commands.push([command, ...args].join(" "));
        // O Docker.app foi para o Lixo: nada responde.
        return { code: 1, stdout: "", stderr: "command not found" };
      },
    };
    const events: InstallerEvent[] = [];
    const result = await runInstall({
      dataDir,
      publicUrl: PUBLIC_URL,
      composeFile: COMPOSE_FILE,
      composeMode: "packaged",
      run,
      fetch: (async () => new Response("not found", { status: 404 })) as typeof fetch,
      clock: clockNow,
      platform: "darwin",
      onEvent: (event) => events.push(event),
    });

    expect(result.ok).toBe(false);
    expect(result.dockerMissing).toBe(true);
    expect(result.error).toBe(
      "O Docker Desktop não está mais instalado neste computador. Rode a instalação de novo para o Quibt baixar o Docker.",
    );
    // Religar nunca baixa o Docker.dmg nem abre o prompt de administrador.
    for (const forbidden of ["/usr/bin/curl", "/usr/bin/osascript", "/usr/bin/hdiutil"]) {
      expect(commands.some((entry) => entry.startsWith(forbidden))).toBe(false);
    }
    expect(commands.some((entry) => entry.includes(" up "))).toBe(false);
    expect(events.at(-1)).toMatchObject({ step: "requirements", status: "failed" });
  });

  it("uma pasta de dados fora do File sharing não vira culpa do ghcr.io", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-start-mount-"));
    ensureInstallEnvironment(dataDir, PUBLIC_URL);
    completeState(dataDir);
    const result = await runInstall({
      dataDir,
      publicUrl: PUBLIC_URL,
      composeFile: COMPOSE_FILE,
      composeMode: "packaged",
      run: {
        async run(command, args) {
          const joined = [command, ...args].join(" ");
          if (joined.includes("image inspect")) {
            return { code: 0, stdout: "sha256:local\n", stderr: "" };
          }
          if (joined.includes(" up ")) {
            return {
              code: 1,
              stdout: "",
              stderr: `Error response from daemon: Mounts denied: The path ${dataDir} is not shared from the host and is not known to Docker.`,
            };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch,
      clock: clockNow,
      platform: "darwin",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain(`O Docker não conseguiu acessar a pasta de dados ${dataDir}`);
    expect(result.error).toContain("Settings → Resources → File sharing");
    expect(result.error).not.toContain("ghcr.io");
    expect(result.errorDetail).toContain("Mounts denied");
  });
});

describe("retornos antecipados avisam quem escuta", () => {
  it("trava ocupada emite um evento failed em português", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-lock-event-"));
    const { acquireInstallLock, releaseInstallLock } = await import("./install-lock.js");
    // O pai do processo de teste está vivo de verdade: a trava não é dada como órfã.
    const holder = process.ppid;
    expect(acquireInstallLock(dataDir, holder, new Date(), () => true).ok).toBe(true);
    const events: InstallerEvent[] = [];
    try {
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
        fetch: (async () => new Response("not found", { status: 404 })) as typeof fetch,
        clock: clockNow,
        platform: "linux",
        onEvent: (event) => events.push(event),
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        "Outra instalação ou atualização do Quibt já está em andamento",
      );
      expect(result.error).toContain(String(holder));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ step: "requirements", status: "failed" });
      expect(events[0]?.message).toBe(result.error);
    } finally {
      releaseInstallLock(dataDir, holder);
    }
  });

  it("versão diferente emite failed mandando atualizar", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-update-event-"));
    writeFileSync(
      path.join(dataDir, "install-state.json"),
      `${JSON.stringify({
        version: 1,
        release: "0.1.0",
        completed: ["requirements"],
        updatedAt: "2026-08-17T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    const events: InstallerEvent[] = [];
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
      fetch: (async () => new Response("not found", { status: 404 })) as typeof fetch,
      clock: clockNow,
      platform: "linux",
      onEvent: (event) => events.push(event),
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.error).toContain("0.1.0");
    expect(result.error).toContain("quibtbot update");
    expect(events).toEqual([
      expect.objectContaining({ step: "requirements", status: "failed", message: result.error }),
    ]);
  });
});
