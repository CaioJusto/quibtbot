-- Bootstrap invites for first-owner pairing and singleton deployment claim marker.

CREATE TABLE "deployment_claim" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deployment_claim_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bootstrap_invites" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "enrollmentTokenHash" TEXT,
    "enrollmentExpiresAt" TIMESTAMP(3),
    "enrollmentConsumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bootstrap_invites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bootstrap_invites_codeHash_key" ON "bootstrap_invites"("codeHash");
CREATE UNIQUE INDEX "bootstrap_invites_tokenHash_key" ON "bootstrap_invites"("tokenHash");
CREATE UNIQUE INDEX "bootstrap_invites_enrollmentTokenHash_key" ON "bootstrap_invites"("enrollmentTokenHash");
CREATE INDEX "bootstrap_invites_expiresAt_idx" ON "bootstrap_invites"("expiresAt");

INSERT INTO "deployment_claim" ("id", "updatedAt") VALUES ('default', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
