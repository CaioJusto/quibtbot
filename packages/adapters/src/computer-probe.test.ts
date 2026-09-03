import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { probeComputer, SUPERVISOR_PROBE_PATH } from "./computer-probe.js";
import {
  SSH_PUBLISHED_WEB_PORTS_MESSAGE,
  type SshDockerPort,
  sshAliasMissingMessage,
} from "./ssh-docker.js";

const resolvePublic = async () => [{ address: "203.0.113.9" }];

describe("probeComputer", () => {
  it("refuses unknown kinds and missing remote URL", async () => {
    expect(await probeComputer({ kind: "desktop" })).toEqual({
      ok: false,
      message: "Máquina desconhecida: desktop",
    });
    expect(await probeComputer({ kind: "remote-supervisor" })).toMatchObject({ ok: false });
  });

  it("accepts cloud keys without calling the vendor", async () => {
    expect(await probeComputer({ kind: "e2b", apiKey: "e2b_live" })).toMatchObject({ ok: true });
    expect(await probeComputer({ kind: "box" })).toMatchObject({ ok: false });
  });

  it("confirms a Quibt Cloud session against /api/me", async () => {
    const fetchImpl = (async (url: string) => {
      expect(String(url)).toContain("/api/me");
      return new Response(
        JSON.stringify({
          plan: { name: "Starter" },
          hoursUsed: 1,
          hoursQuota: 10,
          concurrentComputers: 0,
          concurrentLimit: 1,
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const result = await probeComputer(
      { kind: "quibt-cloud", apiKey: "sess-token" },
      fetchImpl,
    );
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/Starter/);
  });

  it("hits the authenticated probe endpoint, not the open /health", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const result = await probeComputer(
      { kind: "docker", supervisorUrl: "http://127.0.0.1:7091", supervisorToken: "tok" },
      fetchImpl,
    );
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { url: `http://127.0.0.1:7091${SUPERVISOR_PROBE_PATH}`, authorization: "Bearer tok" },
    ]);
  });

  it("falha quando o token está errado, em vez de dizer 'ok'", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })) as typeof fetch;
    const result = await probeComputer(
      {
        kind: "remote-supervisor",
        endpoint: "https://vps.example.com",
        apiKey: "token-errado",
      },
      fetchImpl,
      { resolveHost: resolvePublic },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/token/i);
  });

  it("um supervisor antigo, sem a rota, ainda prova o token com 404", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "computer not found" }), {
        status: 404,
      })) as typeof fetch;
    const result = await probeComputer(
      { kind: "remote-supervisor", endpoint: "https://vps.example.com", apiKey: "tok" },
      fetchImpl,
      { resolveHost: resolvePublic },
    );
    expect(result.ok).toBe(true);
  });

  it("diz que o Docker do supervisor está fora quando ele responde 503", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: false }), { status: 503 })) as typeof fetch;
    const result = await probeComputer(
      { kind: "remote-supervisor", endpoint: "https://vps.example.com", apiKey: "tok" },
      fetchImpl,
      { resolveHost: resolvePublic },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Docker/);
  });

  it("pede o token antes de abrir socket nenhum", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const result = await probeComputer(
      { kind: "remote-supervisor", endpoint: "https://vps.example.com" },
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it("recusa endereço inseguro ou interno sem abrir socket", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    for (const endpoint of [
      "http://vps.example.com:7091",
      "http://169.254.169.254",
      "https://10.0.0.5:7091",
      "https://192.168.1.10:7091",
    ]) {
      const result = await probeComputer(
        { kind: "remote-supervisor", endpoint, apiKey: "tok" },
        fetchImpl,
        { resolveHost: resolvePublic },
      );
      expect(result, endpoint).toMatchObject({ ok: false });
    }
    expect(called).toBe(false);
  });

  it("recusa um nome que resolve para a rede interna (rebinding)", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const result = await probeComputer(
      { kind: "remote-supervisor", endpoint: "https://interno.example.com", apiKey: "tok" },
      fetchImpl,
      { resolveHost: async () => [{ address: "10.1.2.3" }] },
    );
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe("probeComputer — a conferência vale até o socket", () => {
  const servers: Array<{ close: () => void }> = [];
  afterAll(() => {
    for (const server of servers) server.close();
  });

  it("recusa o nome que é público no preflight e privado na hora de conectar", async () => {
    // Sem `fetchImpl`, quem abre a conexão é o transporte fixado: ele confere o IP que vai
    // usar, então o segundo DNS (o do rebinding) não leva o token para dentro da rede.
    const answers = [[{ address: "203.0.113.9" }]];
    let lookups = 0;
    const result = await probeComputer(
      { kind: "remote-supervisor", endpoint: "https://vps.example.com", apiKey: "tok" },
      undefined,
      {
        resolveHost: async () => {
          lookups += 1;
          return answers.shift() ?? [{ address: "169.254.169.254" }];
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/rede interna/);
    expect(lookups).toBeGreaterThanOrEqual(2);
  });

  it("não segue um redirect para o metadado da nuvem", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return new Response("", {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      });
    }) as typeof fetch;
    const result = await probeComputer(
      { kind: "remote-supervisor", endpoint: "https://vps.example.com", apiKey: "tok" },
      fetchImpl,
      { resolveHost: resolvePublic },
    );
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("o supervisor local continua respondendo pelo socket de verdade", async () => {
    const seen: Array<{ url?: string; authorization?: string }> = [];
    const server = createServer((req, res) => {
      seen.push({ url: req.url, authorization: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const result = await probeComputer({
      kind: "docker",
      supervisorUrl: `http://127.0.0.1:${port}`,
      supervisorToken: "tok",
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ url: SUPERVISOR_PROBE_PATH, authorization: "Bearer tok" }]);
  });
});

describe("probeComputer — alias SSH", () => {
  const sshOk = (): SshDockerPort => ({
    resolveAlias: async () => ({ ok: true }),
    refusePublishedWebPorts: async () => undefined,
    supervisorOrigin: async () => "http://127.0.0.1:1",
    openNovncTunnel: async () => {
      throw new Error("probe não abre túnel de tela");
    },
  });

  it("alias ausente falha o Testar em português, sem abrir URL", async () => {
    let fetched = false;
    const result = await probeComputer(
      { kind: "remote-supervisor", endpoint: "ghost-host" },
      (async () => {
        fetched = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      {
        ssh: {
          ...sshOk(),
          resolveAlias: async (alias) => ({
            ok: false,
            message: sshAliasMissingMessage(alias),
          }),
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toBe(sshAliasMissingMessage("ghost-host"));
    expect(fetched).toBe(false);
  });

  it("80/443 publicados reprovam o Testar", async () => {
    const result = await probeComputer(
      { kind: "remote-supervisor", endpoint: "meu-vps" },
      undefined,
      {
        ssh: {
          ...sshOk(),
          refusePublishedWebPorts: async () => {
            throw new Error(SSH_PUBLISHED_WEB_PORTS_MESSAGE);
          },
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toBe(SSH_PUBLISHED_WEB_PORTS_MESSAGE);
  });

  it("alias válido não pede token nem chama o supervisor por https", async () => {
    let fetched = false;
    const result = await probeComputer(
      { kind: "remote-supervisor", endpoint: "meu-vps" },
      (async () => {
        fetched = true;
        return new Response("no", { status: 500 });
      }) as typeof fetch,
      { ssh: sshOk() },
    );
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/ssh:\/\/meu-vps/);
    expect(fetched).toBe(false);
  });
});
