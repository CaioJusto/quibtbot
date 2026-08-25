import { createDb } from "@quibt/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimDeviceCode,
  decideDeviceRequest,
  issueDeviceCode,
  pendingDeviceRequests,
  pollDeviceRequest,
} from "./device-code-store.js";

/** Integração explícita: sem URL de teste, a suíte rápida não tenta adivinhar um banco local. */
const databaseUrl = process.env.PG_TEST_URL ?? process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("fluxo real contra o banco", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: ReturnType<typeof createDb>["prisma"];
  let userId = "";

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    const stamp = Date.now();
    const user = await prisma.user.create({
      data: {
        id: `t${stamp}`,
        name: "Teste",
        email: `t${stamp}@x.test`,
        emailVerified: true,
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await prisma.$disconnect();
    await db.pool.end();
  });

  it("acertar o código não entra; aprovar entra, e só uma vez", async () => {
    const issued = await issueDeviceCode(prisma, userId);
    const claim = await claimDeviceCode(prisma, issued.code, "iPhone de Caio");
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    // Ainda não entrou.
    expect(await pollDeviceRequest(prisma, claim.requestId, claim.secret)).toEqual({
      state: "pending",
    });

    const waiting = await pendingDeviceRequests(prisma, userId);
    expect(waiting[0]?.device).toBe("iPhone de Caio");

    expect(await decideDeviceRequest(prisma, userId, claim.requestId, true)).toBe(true);
    const approved = await pollDeviceRequest(prisma, claim.requestId, claim.secret);
    expect(approved).toEqual({ state: "approved", userId });

    // Entrega única: o segredo foi queimado.
    expect(await pollDeviceRequest(prisma, claim.requestId, claim.secret)).toEqual({
      state: "unknown",
    });
  });

  it("segredo errado não abre nada", async () => {
    const issued = await issueDeviceCode(prisma, userId);
    const claim = await claimDeviceCode(prisma, issued.code, "outro");
    if (!claim.ok) throw new Error("claim falhou");
    await decideDeviceRequest(prisma, userId, claim.requestId, true);
    expect(await pollDeviceRequest(prisma, claim.requestId, "errado")).toEqual({
      state: "unknown",
    });
  });

  it("duas consultas concorrentes entregam a aprovação uma única vez", async () => {
    const issued = await issueDeviceCode(prisma, userId);
    const claim = await claimDeviceCode(prisma, issued.code, "iPhone concorrente");
    if (!claim.ok) throw new Error("claim falhou");
    await decideDeviceRequest(prisma, userId, claim.requestId, true);

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => pollDeviceRequest(prisma, claim.requestId, claim.secret)),
    );
    expect(outcomes.filter((outcome) => outcome.state === "approved")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.state === "unknown")).toHaveLength(7);
  });

  it("outro dono não decide o pedido alheio", async () => {
    const issued = await issueDeviceCode(prisma, userId);
    const claim = await claimDeviceCode(prisma, issued.code, "terceiro");
    if (!claim.ok) throw new Error("claim falhou");
    expect(await decideDeviceRequest(prisma, "outro-usuario", claim.requestId, true)).toBe(false);
  });
});
