import {
  BOOTSTRAP_ENROLLMENT_SCOPE,
  type BootstrapInviteRecord,
  type FirstOwnerEnrollment,
  hashBootstrapSecret,
  isBootstrapEnrollmentConsumed,
  isBootstrapEnrollmentExpired,
  isBootstrapInviteConsumed,
  isBootstrapInviteExpired,
  normalizeBootstrapCode,
} from "@quibt/core/bootstrap-invite";
import {
  createBootstrapEnrollment,
  createBootstrapInvite,
} from "@quibt/core/bootstrap-invite-server";
import type { Prisma, PrismaClient } from "@quibt/db";

export class BootstrapFinalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapFinalizeError";
  }
}

export async function mintBootstrapInvite(prisma: PrismaClient, now = new Date()) {
  const created = createBootstrapInvite(now);
  await prisma.bootstrapInvite.create({
    data: {
      id: created.record.id,
      codeHash: created.record.codeHash,
      tokenHash: created.record.tokenHash,
      expiresAt: created.record.expiresAt,
      createdAt: created.record.createdAt,
    },
  });
  return {
    code: created.code,
    token: created.token,
    expiresAt: created.record.expiresAt.toISOString(),
  };
}

export async function claimBootstrapInvite(prisma: PrismaClient, code: string, now = new Date()) {
  const normalized = normalizeBootstrapCode(code);
  if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(normalized)) {
    return { ok: false as const, status: 400, message: "Código inválido." };
  }
  const codeHash = hashBootstrapSecret(normalized);
  const invite = await prisma.bootstrapInvite.findUnique({ where: { codeHash } });
  if (!invite) {
    return { ok: false as const, status: 400, message: "Código inválido." };
  }
  return consumeBootstrapInvite(prisma, invite as BootstrapInviteRecord, now);
}

/** QR equivalent of the short code: both are one-use secrets for the same invite. */
export async function claimBootstrapInviteToken(
  prisma: PrismaClient,
  token: string,
  now = new Date(),
) {
  const normalized = token.trim();
  if (!normalized) {
    return { ok: false as const, status: 400, message: "Convite inválido." };
  }
  const tokenHash = hashBootstrapSecret(normalized);
  const invite = await prisma.bootstrapInvite.findUnique({ where: { tokenHash } });
  if (!invite) {
    return { ok: false as const, status: 400, message: "Convite inválido." };
  }
  return consumeBootstrapInvite(prisma, invite as BootstrapInviteRecord, now);
}

async function consumeBootstrapInvite(
  prisma: PrismaClient,
  record: BootstrapInviteRecord,
  now: Date,
) {
  if (isBootstrapInviteConsumed(record) || isBootstrapInviteExpired(record, now)) {
    return { ok: false as const, status: 400, message: "Código expirado ou já usado." };
  }

  const enrollment = createBootstrapEnrollment(now);
  const consumed = await prisma.bootstrapInvite.updateMany({
    where: {
      id: record.id,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    data: {
      consumedAt: now,
      enrollmentTokenHash: enrollment.tokenHash,
      enrollmentExpiresAt: enrollment.expiresAt,
    },
  });
  if (consumed.count !== 1) {
    return { ok: false as const, status: 400, message: "Código expirado ou já usado." };
  }

  return {
    ok: true as const,
    enrollmentToken: enrollment.token,
    expiresAt: enrollment.expiresAt.toISOString(),
    scope: BOOTSTRAP_ENROLLMENT_SCOPE,
  };
}

export async function deploymentNeedsFirstOwner(prisma: PrismaClient): Promise<boolean> {
  const [settings, claim] = await Promise.all([
    prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { ownerUserId: true },
    }),
    prisma.deploymentClaim.findUnique({
      where: { id: "default" },
      select: { claimedAt: true },
    }),
  ]);
  return !settings?.ownerUserId && !claim?.claimedAt;
}

export async function validateFirstOwnerEnrollment(
  prisma: PrismaClient,
  token: string | undefined,
  now = new Date(),
): Promise<{ ok: true; enrollment: FirstOwnerEnrollment } | { ok: false; message: string }> {
  if (!token?.trim()) {
    return { ok: false, message: "Este deploy exige um convite de proprietário." };
  }
  const tokenHash = hashBootstrapSecret(token.trim());
  const invite = await prisma.bootstrapInvite.findUnique({
    where: { enrollmentTokenHash: tokenHash },
  });
  if (!invite) {
    return { ok: false, message: "Convite de proprietário inválido." };
  }
  const record = invite as BootstrapInviteRecord;
  if (
    isBootstrapEnrollmentConsumed(record) ||
    isBootstrapEnrollmentExpired(record, now) ||
    !record.consumedAt
  ) {
    return { ok: false, message: "Convite de proprietário expirado ou já usado." };
  }
  return { ok: true, enrollment: { inviteId: invite.id, tokenHash } };
}

export async function prepareFirstOwnerEnrollment(
  prisma: PrismaClient,
  token: string | undefined,
): Promise<
  { ok: true; enrollment?: FirstOwnerEnrollment } | { ok: false; message: string; status: 403 }
> {
  if (!(await deploymentNeedsFirstOwner(prisma))) {
    return { ok: true };
  }
  const checked = await validateFirstOwnerEnrollment(prisma, token);
  if (!checked.ok) {
    return { ok: false, message: checked.message, status: 403 };
  }
  return { ok: true, enrollment: checked.enrollment };
}

export async function finalizeFirstOwnerInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  enrollment: FirstOwnerEnrollment,
  now = new Date(),
): Promise<void> {
  const claim = await tx.deploymentClaim.findUnique({ where: { id: "default" } });
  if (claim?.claimedAt) {
    throw new BootstrapFinalizeError("deployment already claimed");
  }

  const settings = await tx.deploymentSettings.findUnique({ where: { id: "default" } });
  if (settings?.ownerUserId) {
    throw new BootstrapFinalizeError("first owner race lost");
  }

  const consumed = await tx.bootstrapInvite.updateMany({
    where: {
      id: enrollment.inviteId,
      enrollmentTokenHash: enrollment.tokenHash,
      enrollmentConsumedAt: null,
      enrollmentExpiresAt: { gt: now },
      consumedAt: { not: null },
    },
    data: { enrollmentConsumedAt: now },
  });
  if (consumed.count !== 1) {
    throw new BootstrapFinalizeError("enrollment invalid, expired, or already consumed");
  }

  const owner = await tx.deploymentSettings.updateMany({
    where: { id: "default", ownerUserId: null },
    data: { ownerUserId: userId },
  });
  if (owner.count !== 1) {
    throw new BootstrapFinalizeError("first owner race lost");
  }

  const marked = await tx.deploymentClaim.updateMany({
    where: { id: "default", claimedAt: null },
    data: { claimedAt: now },
  });
  if (marked.count !== 1) {
    throw new BootstrapFinalizeError("deployment claim race lost");
  }
}
