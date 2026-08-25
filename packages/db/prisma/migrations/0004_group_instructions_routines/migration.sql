ALTER TABLE "bot_groups" ADD COLUMN "instructions" TEXT NOT NULL DEFAULT '';

ALTER TABLE "routines" ALTER COLUMN "botId" DROP NOT NULL;
ALTER TABLE "routines" ADD COLUMN "groupId" TEXT;
ALTER TABLE "routines" ADD CONSTRAINT "routines_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "bot_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "routines_workspaceId_groupId_idx" ON "routines"("workspaceId", "groupId");
