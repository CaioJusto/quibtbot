import { describe, expect, it } from "vitest";
import net from "node:net";
import {
  classifyBindError,
  decidePublicAccess,
  discoverPublicIpv4,
  instanceLabel,
  isPublicIpv4,
  portIsFree,
  probePortAccepting,
  sslipHost,
} from "./public-access.js";

const fetchReturning =
  (bodies: Record<string, string | number>) =>
  async (url: string | URL | Request): Promise<Response> => {
    const key = String(url);
    const body = bodies[key];
    if (body === undefined) throw new Error(`sem rota para ${key}`);
    if (typeof body === "number") return new Response("", { status: body });
    return new Response(body, { status: 200 });
  };

describe("isPublicIpv4", () => {
  it("aceita um IP roteável de VPS", () => {
    expect(isPublicIpv4("31.97.86.113")).toBe(true);
    expect(isPublicIpv4("203.0.113.9")).toBe(true);
  });

  it("recusa faixas privadas, loopback, link-local, CGNAT e lixo", () => {
    for (const value of [
      "10.0.0.5",
      "172.16.4.4",
      "192.168.68.59",
      "127.0.0.1",
      "169.254.1.1",
      "100.100.1.1",
      "224.0.0.1",
      "0.0.0.0",
      "300.1.1.1",
      "not-an-ip",
      "",
    ]) {
      expect(isPublicIpv4(value), value).toBe(false);
    }
  });
});

describe("discoverPublicIpv4", () => {
  it("usa o primeiro serviço que responde com um IP público", async () => {
    const fetchImpl = fetchReturning({ "https://a": "31.97.86.113\n" });
    expect(await discoverPublicIpv4(fetchImpl as typeof fetch, ["https://a"])).toBe("31.97.86.113");
  });

  it("pula serviço fora do ar ou que devolve IP privado, e só desiste no fim", async () => {
    const fetchImpl = fetchReturning({
      "https://down": 503,
      "https://nat": "192.168.1.7",
      "https://ok": "203.0.113.9",
    });
    expect(
      await discoverPublicIpv4(fetchImpl as typeof fetch, [
        "https://boom",
        "https://down",
        "https://nat",
        "https://ok",
      ]),
    ).toBe("203.0.113.9");
    expect(
      await discoverPublicIpv4(fetchImpl as typeof fetch, ["https://nat", "https://down"]),
    ).toBe(null);
  });
});

describe("portIsFree", () => {
  it("classifica EACCES/EPERM como falta de privilégio, não como porta ocupada", () => {
    expect(classifyBindError("EADDRINUSE")).toBe("busy");
    expect(classifyBindError("EACCES")).toBe("unprivileged");
    expect(classifyBindError("EPERM")).toBe("unprivileged");
    expect(classifyBindError("EADDRNOTAVAIL")).toBe("other");
  });

  it("vê uma porta alta livre e uma que este processo ocupa", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("sem porta");
    try {
      expect(await portIsFree(address.port)).toBe(false);
      expect(await probePortAccepting(address.port)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(await portIsFree(address.port)).toBe(true);
    expect(await probePortAccepting(address.port)).toBe(false);
  });

  it("não trata EACCES em 80/443 como ocupada quando ninguém atende", async () => {
    // `quibtbot install` numa Ubuntu comum roda como ubuntu, não como root.
    // bind(80) dá EACCES; o Docker ainda consegue publicar 80/443. Se o
    // instalador traduz isso em "porta em uso", a VPS limpa fica local e o
    // celular nunca ganha https.
    for (const port of [80, 443]) {
      if (await probePortAccepting(port)) continue;
      expect(await portIsFree(port), `port ${port}`).toBe(true);
    }
  });
});

describe("sslipHost / instanceLabel", () => {
  it("monta o nome que o Let's Encrypt aceita, com rótulo por instalação", () => {
    const label = instanceLabel(() => Buffer.from("a1b2c3d4e5", "hex"));
    expect(label).toBe("quibt-a1b2c3d4");
    expect(sslipHost(label, "31.97.86.113")).toBe("quibt-a1b2c3d4.31.97.86.113.sslip.io");
  });
});

describe("decidePublicAccess", () => {
  const free = async () => true;
  const random = () => Buffer.from("deadbeef", "hex");

  it("vira pública numa VPS limpa: IP público e portas 80/443 livres", async () => {
    const decision = await decidePublicAccess({
      fetch: fetchReturning({ "https://api.ipify.org": "31.97.86.113" }) as typeof fetch,
      checkPort: free,
      random,
    });
    expect(decision).toEqual({
      mode: "public",
      host: "quibt-deadbeef.31.97.86.113.sslip.io",
      url: "https://quibt-deadbeef.31.97.86.113.sslip.io",
      ip: "31.97.86.113",
    });
  });

  it("fica local, e diz por quê, quando o host não tem IP público", async () => {
    const decision = await decidePublicAccess({
      fetch: fetchReturning({ "https://api.ipify.org": "192.168.68.59" }) as typeof fetch,
      checkPort: free,
    });
    expect(decision.mode).toBe("local");
    expect(decision).toMatchObject({ reason: expect.stringMatching(/não tem IP público/) });
  });

  it("fica local quando 80 ou 443 já pertencem a outro serviço, citando a porta", async () => {
    const decision = await decidePublicAccess({
      fetch: fetchReturning({ "https://api.ipify.org": "31.97.86.113" }) as typeof fetch,
      checkPort: async (port) => port !== 443,
    });
    expect(decision).toMatchObject({ mode: "local", reason: expect.stringMatching(/porta 443/) });
  });

  it("respeita --local sem nem perguntar o IP", async () => {
    const decision = await decidePublicAccess({
      forceLocal: true,
      fetch: (async () => {
        throw new Error("não devia consultar a rede");
      }) as typeof fetch,
    });
    expect(decision).toMatchObject({ mode: "local", reason: expect.stringMatching(/--local/) });
  });

  it("reaproveita o host já gravado numa instalação anterior, para o certificado não mudar", async () => {
    const decision = await decidePublicAccess({
      existingHost: "quibt-deadbeef.31.97.86.113.sslip.io",
      fetch: (async () => {
        throw new Error("não devia consultar a rede");
      }) as typeof fetch,
    });
    expect(decision).toEqual({
      mode: "public",
      host: "quibt-deadbeef.31.97.86.113.sslip.io",
      url: "https://quibt-deadbeef.31.97.86.113.sslip.io",
      ip: "31.97.86.113",
    });
  });
});
