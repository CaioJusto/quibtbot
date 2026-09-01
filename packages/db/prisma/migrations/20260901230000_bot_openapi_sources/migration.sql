-- Per-bot OpenAPI 3 document URLs. Authentication material is deliberately unsupported.
CREATE TABLE "bot_openapi_sources" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "disabledReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "bot_openapi_sources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bot_openapi_sources_botId_name_key"
  ON "bot_openapi_sources"("botId", "name");
CREATE INDEX "bot_openapi_sources_workspaceId_botId_idx"
  ON "bot_openapi_sources"("workspaceId", "botId");

ALTER TABLE "bot_openapi_sources"
  ADD CONSTRAINT "bot_openapi_sources_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bot_openapi_sources"
  ADD CONSTRAINT "bot_openapi_sources_botId_fkey"
  FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
