import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  checkDeviceCode,
  createDeviceCode,
  DEVICE_CODE_ENTROPY_BYTES,
  type DeviceCodeRejection,
  deviceCodeHash,
  deviceCodeRejectionMessage,
  deviceLabel,
  deviceRequestState,
  isWellFormedDeviceCode,
} from "@quibt/core/device-code";
import type { PrismaClient } from "@quibt/db";

/**
 * Guarda e resgata os códigos de entrada em outro aparelho.
 *
 * A conta do Quibt mora na máquina de quem instalou; entrar em um aparelho novo é
 * provar que se tem acesso a um aparelho que já está dentro. O código sai de lá e
 * vale uma vez, por poucos minutos. Aqui fica só o hash — quem lê o banco não
 * consegue entrar com o que viu.
 */
export interface IssuedDeviceCode {
  code: string;
  expiresAt: Date;
}

export async function issueDeviceCode(
  prisma: PrismaClient,
  userId: string,
  now = new Date(),
): Promise<IssuedDeviceCode> {
  // Um código por vez: emitir de novo invalida o anterior, então um código
  // dito em voz alta e esquecido não fica valendo em paralelo.
  await prisma.deviceCode.deleteMany({ where: { userId, consumedAt: null } });
  const created = createDeviceCode(
    userId,
    now,
    () => new Uint8Array(randomBytes(DEVICE_CODE_ENTROPY_BYTES)),
    () => randomUUID(),
  );
  await prisma.deviceCode.create({
    data: {
      id: created.record.id,
      userId,
      codeHash: created.record.codeHash,
      expiresAt: created.record.expiresAt,
      attempts: 0,
    },
  });
  return { code: created.code, expiresAt: created.record.expiresAt };
}

export type ClaimResult =
  /** Não é sessão: é um pedido esperando o sim de quem está no computador. */
  | { ok: true; userId: string; requestId: string; secret: string }
  | { ok: false; reason: DeviceCodeRejection; message: string };

export async function claimDeviceCode(
  prisma: PrismaClient,
  rawCode: string,
  device: string,
  now = new Date(),
): Promise<ClaimResult> {
  if (!isWellFormedDeviceCode(rawCode)) {
    return { ok: false, reason: "malformed", message: deviceCodeRejectionMessage("malformed") };
  }
  const codeHash = deviceCodeHash(rawCode);
  const record = await prisma.deviceCode.findUnique({ where: { codeHash } });
  const verdict = checkDeviceCode(
    record
      ? {
          id: record.id,
          userId: record.userId,
          codeHash: record.codeHash,
          expiresAt: record.expiresAt,
          consumedAt: record.consumedAt,
          attempts: record.attempts,
          createdAt: record.createdAt,
        }
      : null,
    now,
  );
  if (!verdict.ok) {
    if (record) {
      // Uma tentativa contra um código que existe conta; passar do limite o queima.
      await prisma.deviceCode
        .update({ where: { id: record.id }, data: { attempts: { increment: 1 } } })
        .catch(() => undefined);
    }
    return {
      ok: false,
      reason: verdict.reason,
      message: deviceCodeRejectionMessage(verdict.reason),
    };
  }
  // Consumo condicional: dois aparelhos digitando o mesmo código, só o primeiro entra.
  // O que nasce daqui é um pedido, não uma sessão — quem está no computador aprova.
  const secret = randomBytes(32).toString("base64url");
  const consumed = await prisma.deviceCode.updateMany({
    where: { id: verdict.record.id, consumedAt: null },
    data: {
      consumedAt: now,
      claimedAt: now,
      deviceName: deviceLabel(device),
      requestSecretHash: hashRequestSecret(secret),
    },
  });
  if (consumed.count !== 1) {
    return { ok: false, reason: "consumed", message: deviceCodeRejectionMessage("consumed") };
  }
  return { ok: true, userId: verdict.record.userId, requestId: verdict.record.id, secret };
}

function hashRequestSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** O que o computador vê enquanto alguém espera do outro lado. */
export async function pendingDeviceRequests(
  prisma: PrismaClient,
  userId: string,
  now = new Date(),
) {
  const rows = await prisma.deviceCode.findMany({
    where: {
      userId,
      claimedAt: { not: null },
      approvedAt: null,
      deniedAt: null,
      expiresAt: { gt: now },
    },
    orderBy: { claimedAt: "desc" },
    take: 10,
  });
  return rows.map((row) => ({
    id: row.id,
    device: deviceLabel(row.deviceName),
    askedAt: (row.claimedAt ?? row.createdAt).toISOString(),
  }));
}

/**
 * A decisão de quem está no computador. Só decide o que é seu e o que ainda está
 * esperando; uma segunda decisão sobre o mesmo pedido não muda nada.
 */
export async function decideDeviceRequest(
  prisma: PrismaClient,
  userId: string,
  requestId: string,
  approved: boolean,
  now = new Date(),
): Promise<boolean> {
  const decided = await prisma.deviceCode.updateMany({
    where: { id: requestId, userId, claimedAt: { not: null }, approvedAt: null, deniedAt: null },
    data: approved ? { approvedAt: now } : { deniedAt: now },
  });
  return decided.count === 1;
}

export type DeviceRequestOutcome =
  | { state: "pending" }
  | { state: "approved"; userId: string }
  | { state: "denied" }
  | { state: "expired" }
  | { state: "unknown" };

/**
 * O celular pergunta como ficou. Exige o segredo criado junto do pedido, então um id
 * vazado não basta; e o segredo é queimado na entrega, para o token sair uma vez só.
 */
export async function pollDeviceRequest(
  prisma: PrismaClient,
  requestId: string,
  secret: string,
  now = new Date(),
): Promise<DeviceRequestOutcome> {
  const row = await prisma.deviceCode.findUnique({ where: { id: requestId } });
  if (!row?.requestSecretHash) return { state: "unknown" };
  const supplied = Buffer.from(hashRequestSecret(secret));
  const expected = Buffer.from(row.requestSecretHash);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return { state: "unknown" };
  }
  const state = deviceRequestState(
    {
      id: row.id,
      userId: row.userId,
      codeHash: row.codeHash,
      expiresAt: row.expiresAt,
      consumedAt: row.consumedAt,
      attempts: row.attempts,
      createdAt: row.createdAt,
      claimedAt: row.claimedAt,
      approvedAt: row.approvedAt,
      deniedAt: row.deniedAt,
    },
    now,
  );
  if (state !== "approved") return { state } as DeviceRequestOutcome;
  const consumed = await prisma.deviceCode
    .updateMany({
      where: {
        id: row.id,
        requestSecretHash: row.requestSecretHash,
        approvedAt: { not: null },
        deniedAt: null,
      },
      data: { requestSecretHash: null },
    })
    .catch(() => ({ count: 0 }));
  if (consumed.count !== 1) return { state: "unknown" };
  return { state: "approved", userId: row.userId };
}

/** Faxina barata: códigos vencidos há mais de um dia não servem nem de histórico. */
export async function purgeStaleDeviceCodes(prisma: PrismaClient, now = new Date()) {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60_000);
  await prisma.deviceCode
    .deleteMany({ where: { expiresAt: { lt: cutoff } } })
    .catch(() => undefined);
}
