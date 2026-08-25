import { describe, expect, it } from "vitest";
import {
  bootstrapRateLimitBucketKey,
  checkPersistentBootstrapRateLimit,
} from "./bootstrap-rate-limit.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("checkPersistentBootstrapRateLimit", () => {
  it("persists counters across separate checks using PostgreSQL", async () => {
    const { createDb } = await import("@quibt/db");
    const { prisma } = createDb(databaseUrl!);
    const key = bootstrapRateLimitBucketKey("claim", "198.51.100.42", "test-encryption-key");
    await prisma.bootstrapRateLimit.deleteMany({ where: { bucketKey: key } });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(
        await checkPersistentBootstrapRateLimit(
          prisma,
          "claim",
          "198.51.100.42",
          "test-encryption-key",
          10,
          60,
        ),
      ).toBe(true);
    }
    expect(
      await checkPersistentBootstrapRateLimit(
        prisma,
        "claim",
        "198.51.100.42",
        "test-encryption-key",
        10,
        60,
      ),
    ).toBe(false);

    await prisma.bootstrapRateLimit.deleteMany({ where: { bucketKey: key } });
    await prisma.$disconnect();
  });
});
