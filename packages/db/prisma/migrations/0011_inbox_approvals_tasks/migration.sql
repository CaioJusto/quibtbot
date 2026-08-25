-- AlterTable
ALTER TABLE "bots" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bots" ADD COLUMN "unread" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bots" ADD COLUMN "autoApprove" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "bots" ADD COLUMN "alwaysAllow" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "bots" ADD COLUMN "chiefOfStaff" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bots" ADD COLUMN "activeConversationId" TEXT;

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "activeLeafId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "messages" ADD COLUMN "conversationId" TEXT;
ALTER TABLE "messages" ADD COLUMN "parentId" TEXT;

-- CreateIndex
CREATE INDEX "conversations_botId_createdAt_idx" ON "conversations"("botId", "createdAt");

-- CreateIndex
CREATE INDEX "messages_conversationId_idx" ON "messages"("conversationId");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
