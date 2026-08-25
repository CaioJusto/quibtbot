-- AlterTable
ALTER TABLE "deployment_settings" ADD COLUMN "webhookPublicUrl" TEXT;

-- AlterTable
ALTER TABLE "runs" ADD COLUMN "webhookId" TEXT;

-- CreateTable
CREATE TABLE "webhooks" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "eventTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "secretHash" TEXT NOT NULL,
    "deliveryCount" INTEGER NOT NULL DEFAULT 0,
    "lastReceivedAt" TIMESTAMP(3),
    "lastRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_attempts" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "eventName" TEXT,
    "preview" TEXT,
    "deliveryId" TEXT,
    "runId" TEXT,
    "reason" TEXT,

    CONSTRAINT "webhook_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "webhooks_endpointId_key" ON "webhooks"("endpointId");

-- CreateIndex
CREATE INDEX "webhooks_workspaceId_botId_idx" ON "webhooks"("workspaceId", "botId");

-- CreateIndex
CREATE INDEX "webhook_attempts_webhookId_receivedAt_idx" ON "webhook_attempts"("webhookId", "receivedAt");

-- CreateIndex
CREATE INDEX "webhook_deliveries_receivedAt_idx" ON "webhook_deliveries"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_webhookId_externalId_key" ON "webhook_deliveries"("webhookId", "externalId");

-- CreateIndex
CREATE INDEX "runs_webhookId_idx" ON "runs"("webhookId");

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "webhooks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_attempts" ADD CONSTRAINT "webhook_attempts_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
