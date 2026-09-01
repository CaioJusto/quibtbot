-- Per-bot MCP tool servers. `env` is intentionally kept off every public projection.
CREATE TABLE "bot_mcp_servers" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "transport" TEXT NOT NULL,
  "command" TEXT,
  "args" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "url" TEXT,
  "env" JSONB,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "disabledReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "bot_mcp_servers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bot_mcp_servers_botId_name_key" ON "bot_mcp_servers"("botId", "name");
CREATE INDEX "bot_mcp_servers_workspaceId_botId_idx" ON "bot_mcp_servers"("workspaceId", "botId");

ALTER TABLE "bot_mcp_servers"
  ADD CONSTRAINT "bot_mcp_servers_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bot_mcp_servers"
  ADD CONSTRAINT "bot_mcp_servers_botId_fkey"
  FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
