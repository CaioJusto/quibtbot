-- Persistent bootstrap rate limits and backfill deployment claim for existing owners.

CREATE TABLE "bootstrap_rate_limits" (
    "bucketKey" TEXT NOT NULL,
    "hitCount" INTEGER NOT NULL,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bootstrap_rate_limits_pkey" PRIMARY KEY ("bucketKey")
);

CREATE INDEX "bootstrap_rate_limits_expiresAt_idx" ON "bootstrap_rate_limits"("expiresAt");

UPDATE "deployment_claim" AS dc
SET "claimedAt" = COALESCE(dc."claimedAt", ds."updatedAt", CURRENT_TIMESTAMP)
FROM "deployment_settings" AS ds
WHERE dc.id = 'default'
  AND ds.id = 'default'
  AND ds."ownerUserId" IS NOT NULL
  AND dc."claimedAt" IS NULL;
