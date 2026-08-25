import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashBootstrapSecret } from "@quibt/core/bootstrap-invite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapRateLimitBucketKey } from "./bootstrap-rate-limit.js";
import { withBootstrapDbLock } from "./bootstrap-test-lock.js";

type App = {
  request: (
    input: string,
    init?: RequestInit,
    env?: { incoming?: { socket?: { remoteAddress?: string } } },
  ) => Promise<Response>;
};

const BOOTSTRAP_SECRET = "test-bootstrap-secret-32chars-minimum";
const ENCRYPTION_KEY = "test-encryption-key-32chars-minimum";
const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-bootstrap-auth-"));
const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

async function mintInvite(
  app: App,
  secret = BOOTSTRAP_SECRET,
  peerAddress = "127.0.0.1",
  headers: Record<string, string> = {},
) {
  return app.request(
    "http://localhost/api/bootstrap/invites",
    {
      method: "POST",
      headers: {
        "x-quibt-bootstrap-secret": secret,
        "content-type": "application/json",
        ...headers,
      },
    },
    { incoming: { socket: { remoteAddress: peerAddress } } },
  );
}

async function claimCode(
  app: App,
  code: string,
  peerAddress = "203.0.113.10",
  headers: Record<string, string> = {},
) {
  return app.request(
    "http://localhost/api/bootstrap/claim",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ code }),
    },
    { incoming: { socket: { remoteAddress: peerAddress } } },
  );
}

async function claimToken(app: App, token: string, peerAddress = "203.0.113.10") {
  return app.request(
    "http://localhost/api/bootstrap/claim",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    },
    { incoming: { socket: { remoteAddress: peerAddress } } },
  );
}

async function signUp(
  app: App,
  email: string,
  enrollment?: string,
  host = "localhost",
  peerAddress = "127.0.0.1",
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: "http://127.0.0.1:5173",
  };
  if (enrollment) headers["x-quibt-enrollment"] = enrollment;
  return app.request(
    `http://${host}/api/auth/sign-up/email`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        email,
        password: "password12",
        name: "Owner",
      }),
    },
    { incoming: { socket: { remoteAddress: peerAddress } } },
  );
}

describeDb.sequential("bootstrap first-owner pairing", () => {
  let app: App;
  let stop: () => Promise<void>;
  let prisma: Awaited<ReturnType<typeof import("./app.js").createApp>>["prisma"];
  const stamp = Date.now();

  beforeEach(async () => {
    await withBootstrapDbLock(async () => {
      await prisma.bootstrapInvite.deleteMany();
      await prisma.bootstrapRateLimit.deleteMany();
      await prisma.deploymentClaim.update({
        where: { id: "default" },
        data: { claimedAt: null },
      });
      await prisma.deploymentSettings.update({
        where: { id: "default" },
        data: { ownerUserId: null, signupsEnabled: true },
      });
    });
  });

  beforeAll(async () => {
    process.env.BOOTSTRAP_SECRET = BOOTSTRAP_SECRET;
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
  });

  afterAll(async () => {
    await stop();
  });

  it("refuses to mint invites from remote peers", async () => {
    const res = await mintInvite(app, BOOTSTRAP_SECRET, "203.0.113.50");
    expect(res.status).toBe(404);
  });

  it("refuses mint when loopback peer is spoofed via forwarded headers", async () => {
    const res = await mintInvite(app, BOOTSTRAP_SECRET, "203.0.113.50", {
      "x-forwarded-for": "127.0.0.1",
      "x-real-ip": "127.0.0.1",
    });
    expect(res.status).toBe(404);
  });

  it("allows mint on loopback peer even if forwarded headers show a remote client", async () => {
    const res = await mintInvite(app, BOOTSTRAP_SECRET, "127.0.0.1", {
      "x-forwarded-for": "203.0.113.99",
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 when the bootstrap secret is wrong", async () => {
    const res = await mintInvite(app, "wrong-secret");
    expect(res.status).toBe(401);
  });

  it("never echoes the bootstrap secret in a successful mint response", async () => {
    const res = await mintInvite(app);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(BOOTSTRAP_SECRET);
    expect(body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(body.token).toBeTruthy();
    expect(body.expiresAt).toBeTruthy();

    const stored = await prisma.bootstrapInvite.findFirst({
      where: { codeHash: hashBootstrapSecret(body.code) },
    });
    expect(stored?.codeHash).toBe(hashBootstrapSecret(body.code));
    expect(stored?.codeHash).not.toBe(body.code);
    expect(JSON.stringify(stored)).not.toContain(body.code);
    expect(JSON.stringify(stored)).not.toContain(body.token);
  });

  it("rate-limits repeated wrong claim codes using persistent counters", async () => {
    const mint = await mintInvite(app);
    const { code } = await mint.json();
    const ip = "198.51.100.55";
    const bucket = bootstrapRateLimitBucketKey("claim", ip, ENCRYPTION_KEY);
    await prisma.bootstrapRateLimit.deleteMany({ where: { bucketKey: bucket } });

    let limited = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const res = await claimCode(app, "ZZZZZZZZ", ip);
      if (res.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);

    await prisma.bootstrapRateLimit.deleteMany({ where: { bucketKey: bucket } });
    const replay = await claimCode(app, code, "198.51.100.7");
    expect(replay.status).toBe(200);
  });

  it("returns an enrollment token once for a valid code", async () => {
    const mint = await mintInvite(app);
    const { code } = await mint.json();
    const claim = await claimCode(app, code);
    expect(claim.status).toBe(200);
    const body = await claim.json();
    expect(body.enrollmentToken).toBeTruthy();
    expect(body.expiresAt).toBeTruthy();

    const row = await prisma.bootstrapInvite.findFirst();
    expect(row?.consumedAt).not.toBeNull();
    expect(row?.enrollmentTokenHash).toBe(hashBootstrapSecret(body.enrollmentToken));
    expect(JSON.stringify(row)).not.toContain(body.enrollmentToken);
  });

  it("exchanges the one-use QR token for an enrollment token", async () => {
    const mint = await mintInvite(app);
    const { token } = await mint.json();
    const claim = await claimToken(app, token);
    expect(claim.status).toBe(200);
    const body = await claim.json();
    expect(body.enrollmentToken).toBeTruthy();
    expect(body.enrollmentToken).not.toBe(token);
    expect(await claimToken(app, token)).toHaveProperty("status", 400);
  });

  it("refuses to replay a consumed invite code", async () => {
    const mint = await mintInvite(app);
    const { code } = await mint.json();
    const first = await claimCode(app, code);
    expect(first.status).toBe(200);
    const second = await claimCode(app, code);
    expect(second.status).toBeGreaterThanOrEqual(400);
  });

  it("blocks signup without enrollment from a public address while the deployment is unclaimed", async () => {
    // Numa VPS, o código impresso pelo instalador continua sendo a única porta.
    const res = await signUp(app, `blocked-${stamp}@quibt.test`, undefined, "quibt.example.com");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      message: expect.stringMatching(/convite|proprietário/i),
    });
  });

  it("requires installer enrollment even for the first account on this machine", async () => {
    // A URL local pode estar atrás de um proxy. Só o convite de uso único emitido pelo
    // instalador prova controle suficiente para criar o proprietário do deploy.
    const res = await signUp(app, `local-${stamp}@quibt.test`);
    expect(res.status).toBe(403);
    const claim = await prisma.deploymentClaim.findUnique({ where: { id: "default" } });
    expect(claim?.claimedAt).toBeNull();
  });

  it("creates the deployment owner, preserves signup policy, and allows public signup after claim", async () => {
    const mint = await mintInvite(app);
    const { code } = await mint.json();
    const claim = await claimCode(app, code);
    const { enrollmentToken } = await claim.json();
    const email = `owner-${stamp}@quibt.test`;

    const signup = await signUp(app, email, enrollmentToken);
    expect(signup.status).toBeLessThan(400);

    const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
    const claimRow = await prisma.deploymentClaim.findUnique({ where: { id: "default" } });
    const user = await prisma.user.findUnique({ where: { email } });
    expect(settings?.ownerUserId).toBe(user?.id);
    expect(settings?.signupsEnabled).toBe(true);
    expect(claimRow?.claimedAt).not.toBeNull();

    const invite = await prisma.bootstrapInvite.findFirst();
    expect(invite?.enrollmentConsumedAt).not.toBeNull();

    const followUp = await signUp(app, `late-${stamp}@quibt.test`);
    expect(followUp.status).toBeLessThan(400);
  });

  it("does not consume enrollment when the deployment already has an owner", async () => {
    const mint = await mintInvite(app);
    const { code } = await mint.json();
    const claim = await claimCode(app, code);
    const { enrollmentToken } = await claim.json();

    await prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: "existing-owner", signupsEnabled: true },
    });
    await prisma.deploymentClaim.update({
      where: { id: "default" },
      data: { claimedAt: new Date() },
    });

    const res = await signUp(app, `already-owned-${stamp}@quibt.test`, enrollmentToken);
    expect(res.status).toBeLessThan(400);

    const invite = await prisma.bootstrapInvite.findFirst();
    expect(invite?.enrollmentConsumedAt).toBeNull();
  });
});

describeDb.sequential("bootstrap first-owner atomic signup", () => {
  let app: App;
  let stop: () => Promise<void>;
  let prisma: Awaited<ReturnType<typeof import("./app.js").createApp>>["prisma"];
  const stamp = Date.now();

  beforeEach(async () => {
    await withBootstrapDbLock(async () => {
      await prisma.bootstrapInvite.deleteMany();
      await prisma.bootstrapRateLimit.deleteMany();
      await prisma.deploymentClaim.update({
        where: { id: "default" },
        data: { claimedAt: null },
      });
      await prisma.deploymentSettings.update({
        where: { id: "default" },
        data: { ownerUserId: null, signupsEnabled: true },
      });
    });
  });

  beforeAll(async () => {
    process.env.BOOTSTRAP_SECRET = BOOTSTRAP_SECRET;
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
  });

  afterAll(async () => {
    await stop();
  });

  async function enrollmentTokenForMint() {
    const mint = await mintInvite(app);
    const { code } = await mint.json();
    const claim = await claimCode(app, code);
    const { enrollmentToken } = await claim.json();
    return enrollmentToken as string;
  }

  it("leaves no auth rows and no session cookie when finalize fails inside the transaction", async () => {
    const enrollmentToken = await enrollmentTokenForMint();
    const email = `finalize-fail-${stamp}@quibt.test`;
    const { createApp } = await import("./app.js");
    const hooked = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      bootstrapSecret: BOOTSTRAP_SECRET,
      encryptionKey: ENCRYPTION_KEY,
      firstOwnerSignupHooks: {
        finalizeInTransaction: async () => {
          throw new Error("injected finalize failure");
        },
      },
    });

    const res = await hooked.app.request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:5173",
        "x-quibt-enrollment": enrollmentToken,
      },
      body: JSON.stringify({
        email,
        password: "password12",
        name: "Owner",
      }),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json();
    expect(body.token).toBeUndefined();
    expect(res.headers.get("set-cookie")).toBeNull();

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user).toBeNull();
    if (user) {
      const accounts = await prisma.account.findMany({ where: { userId: user.id } });
      const sessions = await prisma.session.findMany({ where: { userId: user.id } });
      expect(accounts).toHaveLength(0);
      expect(sessions).toHaveLength(0);
    }

    const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
    expect(settings?.ownerUserId).toBeNull();

    await hooked.stop();
  });

  it("allows only one concurrent enrollment signup to become owner", async () => {
    const enrollmentToken = await enrollmentTokenForMint();
    const emailA = `race-a-${stamp}@quibt.test`;
    const emailB = `race-b-${stamp}@quibt.test`;

    const [resA, resB] = await Promise.all([
      signUp(app, emailA, enrollmentToken),
      signUp(app, emailB, enrollmentToken),
    ]);

    const successes = [resA, resB].filter((res) => res.status < 400);
    expect(successes).toHaveLength(1);

    const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
    expect(settings?.ownerUserId).toBeTruthy();

    const users = await prisma.user.findMany({
      where: { email: { in: [emailA, emailB] } },
    });
    expect(users).toHaveLength(1);
  });

  it("rolls back user creation when finalize fails after inserts", async () => {
    const enrollmentToken = await enrollmentTokenForMint();
    const email = `post-create-fail-${stamp}@quibt.test`;
    const { createApp } = await import("./app.js");
    const hooked = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      bootstrapSecret: BOOTSTRAP_SECRET,
      encryptionKey: ENCRYPTION_KEY,
      firstOwnerSignupHooks: {
        finalizeInTransaction: async (tx, userId, enrollment) => {
          const { finalizeFirstOwnerInTransaction } = await import("./bootstrap.js");
          await finalizeFirstOwnerInTransaction(tx, userId, enrollment);
          throw new Error("injected failure after finalize");
        },
      },
    });

    const res = await hooked.app.request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:5173",
        "x-quibt-enrollment": enrollmentToken,
      },
      body: JSON.stringify({
        email,
        password: "password12",
        name: "Owner",
      }),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();

    await hooked.stop();
  });
});
