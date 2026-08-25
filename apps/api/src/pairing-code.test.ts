import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withBootstrapDbLock } from "./bootstrap-test-lock.js";

/**
 * Entrar num aparelho novo sem e-mail e sem senha.
 *
 * O caminho inteiro contra um Postgres de verdade: o primeiro dono se cadastra só
 * com o nome (o código da instalação já provou o controle da máquina), pede um
 * código curto de dentro da conta e um segundo aparelho troca esse código por uma
 * sessão. Depois, o mesmo código não vale de novo.
 */
type App = {
  request: (
    input: string,
    init?: RequestInit,
    env?: { incoming?: { socket?: { remoteAddress?: string } } },
  ) => Promise<Response>;
};

const BOOTSTRAP_SECRET = "test-bootstrap-secret-32chars-minimum";
const ENCRYPTION_KEY = "test-encryption-key-32chars-minimum";
const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-pairing-"));
const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb.sequential("entrar por código", () => {
  let app: App;
  let stop: () => Promise<void>;
  let prisma: Awaited<ReturnType<typeof import("./app.js").createApp>>["prisma"];
  let sessionCookie = "";
  let userId = "";

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
    const { createApp } = await import("./app.js");
    const handles = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      bootstrapSecret: BOOTSTRAP_SECRET,
      encryptionKey: ENCRYPTION_KEY,
    });
    app = handles.app;
    stop = handles.stop;
    prisma = handles.prisma;

    // Este deploy de teste é compartilhado: abrir o cadastro é parte do preparo.
    await withBootstrapDbLock(async () => {
      await prisma.deploymentClaim.update({ where: { id: "default" }, data: { claimedAt: null } });
      await prisma.deploymentSettings.update({
        where: { id: "default" },
        data: { ownerUserId: null, signupsEnabled: true, signupAllowlist: "" },
      });
    });

    // Instalação nova: o instalador imprime um código, o app troca por um convite,
    // e o cadastro pede só o nome — sem e-mail, sem senha (docs/entrar-sem-senha.md).
    const minted = await app.request(
      "http://localhost/api/bootstrap/invites",
      {
        method: "POST",
        headers: {
          "x-quibt-bootstrap-secret": BOOTSTRAP_SECRET,
          "content-type": "application/json",
        },
      },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
    );
    expect(minted.status).toBe(200);
    const invite = (await minted.json()) as { code: string };
    const claimedInvite = await app.request(
      "http://localhost/api/bootstrap/claim",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: invite.code }),
      },
      { incoming: { socket: { remoteAddress: "203.0.113.10" } } },
    );
    expect(claimedInvite.status).toBe(200);
    const enrollment = ((await claimedInvite.json()) as { enrollmentToken: string })
      .enrollmentToken;

    const signUp = await app.request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:5173",
        "x-quibt-enrollment": enrollment,
      },
      body: JSON.stringify({ name: "Dono" }),
    });
    expect(signUp.status).toBe(200);
    sessionCookie = (signUp.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const owner = await prisma.deploymentSettings.findUniqueOrThrow({ where: { id: "default" } });
    userId = owner.ownerUserId ?? "";
    expect(userId).toBeTruthy();
  });

  afterAll(async () => {
    await prisma.deviceCode.deleteMany({ where: { userId } }).catch(() => undefined);
    await stop();
  });

  async function issue() {
    const res = await app.request("http://localhost/api/pairing/code", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: sessionCookie },
      body: "{}",
    });
    return { status: res.status, body: (await res.json()) as { code?: string } };
  }

  async function claim(code: string, peerAddress = "203.0.113.44") {
    const res = await app.request(
      "http://localhost/api/pairing/claim",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, device: "Celular de teste" }),
      },
      { incoming: { socket: { remoteAddress: peerAddress } } },
    );
    return {
      status: res.status,
      body: (await res.json()) as { requestId?: string; secret?: string; message?: string },
    };
  }

  /** Quem está no computador diz sim; só então nasce a sessão. */
  async function approve(requestId: string) {
    const res = await app.request("http://localhost/rpc/deviceRequests/decide", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: sessionCookie,
        origin: "http://127.0.0.1:5173",
      },
      body: JSON.stringify({ json: { requestId, approved: true } }),
    });
    return res.status;
  }

  async function poll(request: { requestId?: string; secret?: string }) {
    const res = await app.request("http://localhost/api/pairing/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    return {
      status: res.status,
      body: (await res.json()) as { state?: string; token?: string; message?: string },
    };
  }

  it("só quem já está dentro emite um código", async () => {
    const res = await app.request("http://localhost/api/pairing/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("acertar o código não entra: só depois do sim no computador nasce a sessão", async () => {
    const issued = await issue();
    expect(issued.status).toBe(200);
    const code = issued.body.code ?? "";
    expect(code).toHaveLength(8);

    const claimed = await claim(code);
    expect(claimed.status).toBe(200);
    expect(claimed.body.requestId).toBeTruthy();

    // Enquanto ninguém aprova, o aparelho novo continua do lado de fora.
    expect((await poll(claimed.body)).body.state).toBe("pending");

    expect(await approve(claimed.body.requestId ?? "")).toBe(200);
    const approved = await poll(claimed.body);
    expect(approved.body.state).toBe("approved");
    expect(approved.body.token).toBeTruthy();

    // Entrega única: o mesmo pedido não devolve a sessão de novo.
    expect((await poll(claimed.body)).body.state).not.toBe("approved");
  });

  it("a sessão criada pelo código vale de verdade na API", async () => {
    const issued = await issue();
    const claimed = await claim(issued.body.code ?? "");
    await approve(claimed.body.requestId ?? "");
    const approved = await poll(claimed.body);
    const me = await app.request("http://localhost/rpc/me", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${approved.body.token}`,
        origin: "http://127.0.0.1:5173",
      },
      body: JSON.stringify({ json: {} }),
    });
    expect(me.status).toBe(200);
    const payload = (await me.json()) as { json?: { userId?: string } };
    expect(payload.json?.userId).toBe(userId);
  });

  it("emitir de novo invalida o código anterior", async () => {
    const first = await issue();
    const second = await issue();
    expect(second.body.code).not.toBe(first.body.code);
    expect((await claim(first.body.code ?? "")).status).toBe(400);
    expect((await claim(second.body.code ?? "")).status).toBe(200);
  });

  it("recusa código malformado e código que não existe, sem dizer qual é qual", async () => {
    expect((await claim("123", "203.0.113.77")).status).toBe(400);
    const unknown = await claim("ZZZZZZZZ", "203.0.113.78");
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toBe("Código não confere.");
  });
});
