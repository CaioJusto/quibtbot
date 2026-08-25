-- Separate boot-orphan and lifecycle intent identities on orphan_provisions.

ALTER TABLE "orphan_provisions"
  ADD CONSTRAINT "orphan_provisions_lifecycle_session_bot_id_check"
  CHECK ("lifecycleAction" IS NULL OR "sessionBotId" IS NOT NULL);

DROP INDEX "orphan_provisions_workspaceId_provider_providerRef_key";

CREATE UNIQUE INDEX "orphan_provisions_boot_orphan_identity_key"
  ON "orphan_provisions"("workspaceId", "provider", "providerRef")
  WHERE "lifecycleAction" IS NULL;

CREATE UNIQUE INDEX "orphan_provisions_lifecycle_identity_key"
  ON "orphan_provisions"("workspaceId", "sessionBotId", "lifecycleAction")
  WHERE "lifecycleAction" IS NOT NULL;
