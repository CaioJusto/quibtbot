-- Orphan sandbox provisions pending reconciliation (independent of boot claim tokens).
-- `id` uses Prisma @default(cuid()) on create; the client generates ids (no SQL default).

CREATE TABLE "orphan_provisions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "botId" TEXT,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orphan_provisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "orphan_provisions_workspaceId_provider_providerRef_key" ON "orphan_provisions"("workspaceId", "provider", "providerRef");

CREATE INDEX "orphan_provisions_status_createdAt_idx" ON "orphan_provisions"("status", "createdAt");

ALTER TABLE "orphan_provisions" ADD CONSTRAINT "orphan_provisions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
