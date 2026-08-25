-- Bot collaboration adds shared group threads and explicit bot message authorship.
ALTER TABLE "threads" ALTER COLUMN "botId" DROP NOT NULL;
ALTER TABLE "threads" ADD COLUMN "botGroupId" TEXT;

CREATE TABLE "bot_groups" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "bot_groups_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bot_group_members" (
    "groupId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bot_group_members_pkey" PRIMARY KEY ("groupId", "botId")
);

ALTER TABLE "messages" ADD COLUMN "fromBotId" TEXT;
ALTER TABLE "messages" ADD COLUMN "authorBotId" TEXT;
ALTER TABLE "events" ALTER COLUMN "botId" DROP NOT NULL;

CREATE UNIQUE INDEX "threads_botGroupId_key" ON "threads"("botGroupId");
CREATE INDEX "bot_groups_workspaceId_userId_idx" ON "bot_groups"("workspaceId", "userId");
CREATE INDEX "bot_group_members_botId_idx" ON "bot_group_members"("botId");
CREATE INDEX "messages_fromBotId_idx" ON "messages"("fromBotId");
CREATE INDEX "messages_authorBotId_idx" ON "messages"("authorBotId");

ALTER TABLE "bot_groups" ADD CONSTRAINT "bot_groups_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_group_members" ADD CONSTRAINT "bot_group_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "bot_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_group_members" ADD CONSTRAINT "bot_group_members_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "threads" ADD CONSTRAINT "threads_botGroupId_fkey" FOREIGN KEY ("botGroupId") REFERENCES "bot_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_fromBotId_fkey" FOREIGN KEY ("fromBotId") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_authorBotId_fkey" FOREIGN KEY ("authorBotId") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "threads" ADD CONSTRAINT "threads_owner_check" CHECK (("botId" IS NOT NULL)::int + ("botGroupId" IS NOT NULL)::int = 1);

-- One shared machine per workspace, with one graphical desktop session per bot.
CREATE TABLE "desktop_sessions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "computerId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "display" INTEGER NOT NULL,
    "providerRef" TEXT,
    "screenUrl" TEXT,
    "state" TEXT NOT NULL DEFAULT 'stopped',
    "controlHolder" TEXT NOT NULL DEFAULT 'none',
    "controlLeaseId" TEXT,
    "controlFence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "desktop_sessions_pkey" PRIMARY KEY ("id")
);

WITH ranked AS (
    SELECT
        c.*,
        FIRST_VALUE(c."id") OVER (
            PARTITION BY c."workspaceId"
            ORDER BY c."createdAt", c."id"
        ) AS "sharedComputerId",
        ROW_NUMBER() OVER (
            PARTITION BY c."workspaceId"
            ORDER BY c."createdAt", c."id"
        ) AS "display"
    FROM "computers" c
)
INSERT INTO "desktop_sessions" (
    "id", "workspaceId", "computerId", "botId", "display", "providerRef", "screenUrl", "state",
    "controlHolder", "controlLeaseId", "controlFence", "createdAt", "updatedAt"
)
SELECT
    r."id", r."workspaceId", r."sharedComputerId", r."botId", r."display"::INTEGER,
    CASE WHEN r."kind" = 'docker' THEN NULL ELSE r."providerRef" END,
    CASE WHEN r."kind" = 'docker' THEN NULL ELSE r."screenUrl" END,
    CASE WHEN r."kind" = 'docker' THEN 'stopped' ELSE r."state" END,
    r."controlHolder", r."controlLeaseId", r."controlFence", r."createdAt", r."updatedAt"
FROM ranked r;

WITH ranked AS (
    SELECT
        c."id",
        ROW_NUMBER() OVER (
            PARTITION BY c."workspaceId"
            ORDER BY c."createdAt", c."id"
        ) AS "position"
    FROM "computers" c
)
DELETE FROM "computers" c
USING ranked r
WHERE c."id" = r."id" AND r."position" > 1;

UPDATE "computers"
SET "providerRef" = NULL, "state" = 'stopped'
WHERE "kind" = 'docker';

DROP INDEX "computers_botId_key";
ALTER TABLE "computers" DROP CONSTRAINT "computers_botId_fkey";
ALTER TABLE "computers" DROP COLUMN "botId",
DROP COLUMN "controlHolder",
DROP COLUMN "controlLeaseId",
DROP COLUMN "controlFence",
DROP COLUMN "screenUrl";

CREATE UNIQUE INDEX "computers_workspaceId_key" ON "computers"("workspaceId");
CREATE UNIQUE INDEX "desktop_sessions_botId_key" ON "desktop_sessions"("botId");
CREATE UNIQUE INDEX "desktop_sessions_computerId_display_key" ON "desktop_sessions"("computerId", "display");
CREATE INDEX "desktop_sessions_workspaceId_botId_idx" ON "desktop_sessions"("workspaceId", "botId");

ALTER TABLE "desktop_sessions" ADD CONSTRAINT "desktop_sessions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "desktop_sessions" ADD CONSTRAINT "desktop_sessions_computerId_fkey" FOREIGN KEY ("computerId") REFERENCES "computers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "desktop_sessions" ADD CONSTRAINT "desktop_sessions_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
