import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import {
  BlockedAddressError,
  createGuardedFetch,
  type ProbeNetworkPolicy,
  type ProbeRequest,
} from "./pinned-fetch.js";

/** A política pública: nome vale pelo IP, nenhum host é confiado pelo texto. */
const publicOnly: ProbeNetworkPolicy = {
  isTrustedHost: () => false,
  isAllowedLiteral: (address) => !/^(10\.|127\.|169\.254\.|192\.168\.)/.test(address),
};

const loopbackOk: ProbeNetworkPolicy = {
  isTrustedHost: (hostname) => hostname === "localhost",
  isAllowedLiteral: (address) => address.startsWith("127.") || address === "203.0.113.9",
};

type FakeReply = { status?: number; headers?: Record<string, string>; body?: string };

/** Um `http.request` de mentira: guarda as opções e devolve a resposta combinada. */
function fakeRequest(replies: FakeReply[]) {
  const seen: Array<Record<string, unknown>> = [];
  const requestImpl = ((options, callback) => {
    seen.push(options as unknown as Record<string, unknown>);
    const reply = replies[seen.length - 1] ?? { status: 200 };
    const res = Readable.from([Buffer.from(reply.body ?? "{}")]) as unknown as IncomingMessage;
    res.statusCode = reply.status ?? 200;
    res.statusMessage = "OK";
    res.headers = reply.headers ?? {};
    queueMicrotask(() => callback(res));
    return {
      on: () => undefined,
      write: () => undefined,
      end: () => undefined,
    } as unknown as ReturnType<ProbeRequest>;
  }) as ProbeRequest;
  return { requestImpl, seen };
}

/** O que o `lookup` do socket entrega quando o Node pede a lista inteira. */
function pinnedAddresses(options: Record<string, unknown>): string[] {
  const lookup = options.lookup as (
    hostname: string,
    opts: { all?: boolean },
    cb: (err: Error | null, value: unknown) => void,
  ) => void;
  let out: string[] = [];
  let failure: Error | null = null;
  lookup(String(options.hostname), { all: true }, (err, value) => {
    failure = err;
    out = err ? [] : (value as Array<{ address: string }>).map(({ address }) => address);
  });
  if (failure) throw failure;
  return out;
}

describe("createGuardedFetch — o socket vai ao IP conferido", () => {
  it("fixa o IP aprovado e mantém o nome no Host e no SNI", async () => {
    const { requestImpl, seen } = fakeRequest([{ status: 200 }]);
    let lookups = 0;
    const send = createGuardedFetch({
      policy: publicOnly,
      requestImpl,
      resolveHost: async () => {
        lookups += 1;
        return [{ address: "93.184.216.34" }];
      },
    });
    const res = await send("https://modelos.example.com/v1/models");
    expect(res.status).toBe(200);

    const call = seen[0]!;
    // O nome continua no lugar do nome: Host do virtual host e SNI do TLS não mudam.
    expect(call.hostname).toBe("modelos.example.com");
    expect(call.servername).toBe("modelos.example.com");
    expect(call.port).toBe(443);
    expect(call.path).toBe("/v1/models");
    // Não reutiliza um socket global aberto fora desta política e, portanto, fora da
    // lista de IPs pinada.
    expect(call.agent).toBe(false);
    // ...e o pacote só sai para o IP que a política aprovou.
    expect(pinnedAddresses(call)).toEqual(["93.184.216.34"]);
    // Uma resolução só: não sobra janela entre conferir e conectar.
    expect(lookups).toBe(1);
  });

  it("recusa antes do socket quando o nome resolve para a rede interna", async () => {
    const { requestImpl, seen } = fakeRequest([{ status: 200 }]);
    const send = createGuardedFetch({
      policy: publicOnly,
      requestImpl,
      resolveHost: async () => [{ address: "10.1.2.3" }],
    });
    await expect(send("https://interno.example.com/v1/models")).rejects.toBeInstanceOf(
      BlockedAddressError,
    );
    expect(seen).toHaveLength(0);
  });

  it("o lookup do socket não entrega um IP que a política não viu", async () => {
    // O DNS vira privado na segunda resposta: o socket usa a lista já conferida, e o
    // endereço novo nunca chega ao connect.
    const answers = [[{ address: "93.184.216.34" }], [{ address: "169.254.169.254" }]];
    const { requestImpl, seen } = fakeRequest([{ status: 200 }]);
    const send = createGuardedFetch({
      policy: publicOnly,
      requestImpl,
      resolveHost: async () => answers.shift() ?? [{ address: "169.254.169.254" }],
    });
    await send("https://modelos.example.com/v1/models");
    expect(pinnedAddresses(seen[0]!)).toEqual(["93.184.216.34"]);
  });

  it("recusa o redirect para a rede interna, e não faz a segunda requisição", async () => {
    for (const location of ["http://169.254.169.254/latest/meta-data", "http://10.0.0.5/"]) {
      const { requestImpl, seen } = fakeRequest([{ status: 302, headers: { location } }]);
      const send = createGuardedFetch({
        policy: publicOnly,
        requestImpl,
        resolveHost: async () => [{ address: "93.184.216.34" }],
      });
      await expect(send("https://modelos.example.com/v1/models")).rejects.toBeInstanceOf(
        BlockedAddressError,
      );
      expect(seen).toHaveLength(1);
    }
  });

  it("segue um redirect público, confere o salto e larga a credencial fora da origem", async () => {
    const { requestImpl, seen } = fakeRequest([
      { status: 302, headers: { location: "https://outro.example.com/models" } },
      { status: 200 },
    ]);
    const send = createGuardedFetch({
      policy: publicOnly,
      requestImpl,
      resolveHost: async () => [{ address: "93.184.216.34" }],
    });
    const res = await send("https://modelos.example.com/v1/models", {
      headers: { authorization: "Bearer segredo" },
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect((seen[0]!.headers as Record<string, string>).authorization).toBe("Bearer segredo");
    expect((seen[1]!.headers as Record<string, string>).authorization).toBeUndefined();
    expect(seen[1]!.hostname).toBe("outro.example.com");
  });

  it("entrega o 3xx cru para quem pediu redirect manual", async () => {
    const { requestImpl, seen } = fakeRequest([
      { status: 302, headers: { location: "http://169.254.169.254/" } },
    ]);
    const send = createGuardedFetch({
      policy: publicOnly,
      requestImpl,
      resolveHost: async () => [{ address: "93.184.216.34" }],
    });
    const res = await send("https://modelos.example.com/v1/models", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(seen).toHaveLength(1);
  });
});

describe("createGuardedFetch — socket de verdade", () => {
  const servers: Array<{ close: () => void }> = [];
  afterAll(() => {
    for (const server of servers) server.close();
  });

  it("desiste no AbortSignal quando o servidor aceita e não responde", async () => {
    const server = createServer(() => {
      // Nunca responde: só o signal termina a espera.
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const send = createGuardedFetch({ policy: loopbackOk });
    await expect(
      send(`http://127.0.0.1:${port}/api/tags`, { signal: AbortSignal.timeout(50) }),
    ).rejects.toThrow();
  });

  it("fala com um servidor local, com o Host do virtual host intacto", async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ host: req.headers.host, path: req.url }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const send = createGuardedFetch({ policy: loopbackOk });
    const res = await send(`http://127.0.0.1:${port}/api/tags`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ host: `127.0.0.1:${port}`, path: "/api/tags" });
  });
});
