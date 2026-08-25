import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installCapability } from "./capabilities.js";
import { createDb } from "./client.js";

if (!process.env.DATABASE_URL && existsSync(path.resolve(".env"))) {
  for (const line of readFileSync(path.resolve(".env"), "utf8").split("\n")) {
    const [key, ...rest] = line.split("=");
    if (key?.trim() === "DATABASE_URL") process.env.DATABASE_URL = rest.join("=").trim();
  }
}

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("capability install concurrency", () => {
  const db = createDb(process.env.DATABASE_URL!);
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const workspaceId = `capability-${stamp}`;
  const userId = `user-${stamp}`;

  beforeAll(async () => {
    await db.prisma.organization.create({
      data: {
        id: workspaceId,
        name: "Capability test",
        slug: `capability-${stamp}`,
        createdAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await db.prisma.organization.delete({ where: { id: workspaceId } }).catch(() => undefined);
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("deduplicates simultaneous identical installs under an actor advisory lock", async () => {
    const rows = await Promise.all(
      Array.from({ length: 8 }, () =>
        installCapability(db.prisma, {
          workspaceId,
          userId,
          kind: "mcp",
          name: "Notes",
          source: "https://example.com/mcp",
          config: {},
        }),
      ),
    );
    expect(new Set(rows.map((row) => row.id)).size).toBe(1);
    expect(
      await db.prisma.capabilityInstall.count({
        where: { workspaceId, userId },
      }),
    ).toBe(1);
  });
});
