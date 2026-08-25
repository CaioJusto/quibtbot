-- Boot claim fencing for workspace computer warm and per-bot desktop boot.

ALTER TABLE "computers" ADD COLUMN "bootClaimToken" TEXT;
ALTER TABLE "computers" ADD COLUMN "bootClaimedAt" TIMESTAMP(3);
ALTER TABLE "computers" ADD COLUMN "bootLastError" TEXT;

ALTER TABLE "desktop_sessions" ADD COLUMN "bootClaimToken" TEXT;
ALTER TABLE "desktop_sessions" ADD COLUMN "bootClaimedAt" TIMESTAMP(3);
ALTER TABLE "desktop_sessions" ADD COLUMN "bootLastError" TEXT;
