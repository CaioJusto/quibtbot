-- Takeover control is a real lease now: it belongs to one member and it expires.
-- AlterTable
ALTER TABLE "desktop_sessions" ADD COLUMN "controlLeaseUserId" TEXT;
ALTER TABLE "desktop_sessions" ADD COLUMN "controlLeaseExpiresAt" TIMESTAMP(3);

-- Rows written before the deadline existed hold the keyboard forever. Hand them back to the bot;
-- anyone still at the screen only has to press "take over" again.
UPDATE "desktop_sessions"
SET "controlHolder" = 'bot', "controlLeaseId" = NULL
WHERE "controlHolder" = 'user';
