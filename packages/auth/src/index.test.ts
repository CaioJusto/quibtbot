import type { PrismaClient } from "@quibt/db";
import { describe, expect, it } from "vitest";
import { blockedAuthPaths, provisionUserWorkspace, provisionUserWorkspaceInTx } from "./index.js";

describe("auth policy", () => {
  it("blocks invitation and org-creation paths in version 1", () => {
    expect(blockedAuthPaths.some((p) => p.includes("invite"))).toBe(true);
    expect(blockedAuthPaths.some((p) => p.includes("create"))).toBe(true);
  });
});

interface State {
  organizations: Array<{ id: string }>;
  members: Array<{ id: string; organizationId: string; userId: string; role: string }>;
  memoryDocuments: Array<{ workspaceId: string; userId: string; path: string }>;
  notificationPreferences: Array<{ workspaceId: string; userId: string }>;
}

/**
 * Prisma stand-in with a real interactive transaction: everything a callback
 * writes is discarded when the callback throws, like Postgres would do.
 */
function fakePrisma(options: { failOn?: keyof State } = {}) {
  const committed: State = {
    organizations: [],
    members: [],
    memoryDocuments: [],
    notificationPreferences: [],
  };
  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const draft: State = structuredClone(committed);
      const tx = {
        member: {
          findFirst: async ({ where }: { where: { userId: string } }) =>
            draft.members.find((row) => row.userId === where.userId) ?? null,
          create: async ({ data }: { data: State["members"][number] }) => {
            if (options.failOn === "members") throw new Error("member insert failed");
            draft.members.push(data);
            return data;
          },
        },
        organization: {
          create: async ({ data }: { data: { id: string } }) => {
            if (options.failOn === "organizations") throw new Error("org insert failed");
            draft.organizations.push({ id: data.id });
            return data;
          },
        },
        memoryDocument: {
          create: async ({ data }: { data: State["memoryDocuments"][number] }) => {
            if (options.failOn === "memoryDocuments") throw new Error("memory insert failed");
            draft.memoryDocuments.push(data);
            return data;
          },
        },
        notificationPreference: {
          create: async ({ data }: { data: State["notificationPreferences"][number] }) => {
            if (options.failOn === "notificationPreferences") {
              throw new Error("preference insert failed");
            }
            draft.notificationPreferences.push(data);
            return data;
          },
        },
      };
      const result = await fn(tx);
      Object.assign(committed, draft);
      return result;
    },
  };
  return { prisma: prisma as unknown as PrismaClient, state: committed };
}

describe("provisionUserWorkspace", () => {
  it("creates the personal workspace with member, memory and preferences", async () => {
    const fake = fakePrisma();
    await provisionUserWorkspace(fake.prisma, { id: "user-1" });
    expect(fake.state.organizations).toHaveLength(1);
    expect(fake.state.members[0]).toMatchObject({ userId: "user-1", role: "owner" });
    expect(fake.state.memoryDocuments[0]?.path).toBe("USER.md");
    expect(fake.state.notificationPreferences).toHaveLength(1);
  });

  it("leaves no half-provisioned user when a later insert fails", async () => {
    const fake = fakePrisma({ failOn: "notificationPreferences" });
    await expect(provisionUserWorkspace(fake.prisma, { id: "user-1" })).rejects.toThrow(
      /preference insert failed/,
    );
    expect(fake.state.organizations).toEqual([]);
    expect(fake.state.members).toEqual([]);
    expect(fake.state.memoryDocuments).toEqual([]);
  });

  it("is idempotent when the hook runs twice", async () => {
    const fake = fakePrisma();
    await provisionUserWorkspace(fake.prisma, { id: "user-1" });
    await provisionUserWorkspace(fake.prisma, { id: "user-1" });
    expect(fake.state.organizations).toHaveLength(1);
    expect(fake.state.members).toHaveLength(1);
    expect(fake.state.notificationPreferences).toHaveLength(1);
  });
});

describe("provisionUserWorkspaceInTx", () => {
  it("rolls back workspace rows when finalize fails in the same transaction", async () => {
    const fake = fakePrisma();
    await expect(
      fake.prisma.$transaction(async (tx) => {
        await provisionUserWorkspaceInTx(tx as never, "user-1");
        throw new Error("finalize failed");
      }),
    ).rejects.toThrow(/finalize failed/);
    expect(fake.state.organizations).toHaveLength(0);
    expect(fake.state.members).toHaveLength(0);
  });
});
