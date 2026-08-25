import { randomBytes } from "node:crypto";
import type { Prisma } from "@quibt/db";

export function newAuthId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Personal workspace rows for a new user. Must run inside the caller's transaction
 * so user + workspace + bootstrap finalize commit or roll back together.
 */
export async function provisionUserWorkspaceInTx(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  const existingMember = await tx.member.findFirst({ where: { userId } });
  if (existingMember) return;

  const orgId = newAuthId();
  const now = new Date();
  await tx.organization.create({
    data: {
      id: orgId,
      name: "Personal",
      slug: `user-${userId.slice(0, 12)}`,
      createdAt: now,
    },
  });
  await tx.member.create({
    data: {
      id: newAuthId(),
      organizationId: orgId,
      userId,
      role: "owner",
      createdAt: now,
    },
  });
  await tx.memoryDocument.create({
    data: {
      workspaceId: orgId,
      userId,
      scope: "user",
      path: "USER.md",
      content: "",
    },
  });
  await tx.notificationPreference.create({
    data: {
      workspaceId: orgId,
      userId,
    },
  });
}
