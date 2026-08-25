import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashBootstrapSecret } from "@quibt/core/bootstrap-invite";
import {
  createBootstrapEnrollment,
  createBootstrapInvite,
} from "@quibt/core/bootstrap-invite-server";
import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import { BootstrapFinalizeError, finalizeFirstOwnerInTransaction } from "./bootstrap.js";
import { bootstrapIt, withBootstrapDbLock } from "./bootstrap-test-lock.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb.sequential("finalizeFirstOwnerInTransaction", () => {
  let prisma: Awaited<ReturnType<typeof import("./app.js").createApp>>["prisma"];
  let stop: () => Promise<void>;
  const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-bootstrap-finalize-"));

  beforeAll(async () => {
    const { createApp } = await import("./app.js");
    const handles = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
    });
    prisma = handles.prisma;
    stop = handles.stop;
  });

  afterAll(async () => {
    await stop();
  });

  beforeEach(async () => {
    await withBootstrapDbLock(async () => {
      await prisma.bootstrapInvite.deleteMany();
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

  async function seedClaimedInvite() {
    const now = new Date();
    const created = createBootstrapInvite(now);
    const enrollment = createBootstrapEnrollment(now);
    await prisma.bootstrapInvite.create({
      data: {
        id: created.record.id,
        codeHash: created.record.codeHash,
        tokenHash: created.record.tokenHash,
        expiresAt: created.record.expiresAt,
        consumedAt: now,
        enrollmentTokenHash: enrollment.tokenHash,
        enrollmentExpiresAt: enrollment.expiresAt,
        createdAt: created.record.createdAt,
      },
    });
    return {
      inviteId: created.record.id,
      tokenHash: enrollment.tokenHash,
      enrollmentToken: enrollment.token,
    };
  }

  bootstrapIt("consumes enrollment, assigns owner, and marks claimed atomically", async () => {
    const seeded = await seedClaimedInvite();
    const userId = `finalize-ok-${Date.now()}`;
    await prisma.$transaction(async (tx) =>
      finalizeFirstOwnerInTransaction(tx, userId, {
        inviteId: seeded.inviteId,
        tokenHash: seeded.tokenHash,
      }),
    );

    const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
    const claim = await prisma.deploymentClaim.findUnique({ where: { id: "default" } });
    const invite = await prisma.bootstrapInvite.findUnique({ where: { id: seeded.inviteId } });
    expect(settings?.ownerUserId).toBe(userId);
    expect(claim?.claimedAt).not.toBeNull();
    expect(invite?.enrollmentConsumedAt).not.toBeNull();
  });

  bootstrapIt("throws and rolls back when the owner slot is already taken", async () => {
    const seeded = await seedClaimedInvite();
    await prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: "existing-owner" },
    });

    await expect(
      prisma.$transaction(async (tx) =>
        finalizeFirstOwnerInTransaction(tx, "late-owner", {
          inviteId: seeded.inviteId,
          tokenHash: seeded.tokenHash,
        }),
      ),
    ).rejects.toBeInstanceOf(BootstrapFinalizeError);

    const invite = await prisma.bootstrapInvite.findUnique({ where: { id: seeded.inviteId } });
    expect(invite).toBeTruthy();
    expect(invite?.enrollmentConsumedAt).toBeNull();
    const claim = await prisma.deploymentClaim.findUnique({ where: { id: "default" } });
    expect(claim?.claimedAt).toBeNull();
  });

  bootstrapIt("throws when two finalizers race for the same enrollment", async () => {
    const seeded = await seedClaimedInvite();
    const winner = `winner-${Date.now()}`;
    const loser = `loser-${Date.now()}`;

    await prisma.$transaction(async (tx) =>
      finalizeFirstOwnerInTransaction(tx, winner, {
        inviteId: seeded.inviteId,
        tokenHash: seeded.tokenHash,
      }),
    );

    await expect(
      prisma.$transaction(async (tx) =>
        finalizeFirstOwnerInTransaction(tx, loser, {
          inviteId: seeded.inviteId,
          tokenHash: seeded.tokenHash,
        }),
      ),
    ).rejects.toBeInstanceOf(BootstrapFinalizeError);

    const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
    expect(settings?.ownerUserId).toBe(winner);
    const invite = await prisma.bootstrapInvite.findUnique({ where: { id: seeded.inviteId } });
    expect(invite?.enrollmentConsumedAt).not.toBeNull();
    expect(invite?.enrollmentTokenHash).toBe(hashBootstrapSecret(seeded.enrollmentToken));
  });
});
