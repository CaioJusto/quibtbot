-- Lifecycle context for orphan cleanup intents (stop/destroy claims).

ALTER TABLE "orphan_provisions" ADD COLUMN "lifecycleAction" TEXT;
ALTER TABLE "orphan_provisions" ADD COLUMN "lifecycleToken" TEXT;
ALTER TABLE "orphan_provisions" ADD COLUMN "sessionBotId" TEXT;
ALTER TABLE "orphan_provisions" ADD COLUMN "refSnapshotKind" TEXT;
ALTER TABLE "orphan_provisions" ADD COLUMN "refSnapshotProviderRef" TEXT;

CREATE INDEX "orphan_provisions_lifecycleAction_status_createdAt_idx" ON "orphan_provisions"("lifecycleAction", "status", "createdAt");
