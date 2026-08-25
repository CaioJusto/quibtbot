CREATE TABLE "push_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "push_tokens_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "push_tickets" (
    "id" TEXT NOT NULL,
    "pushTokenId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "push_tickets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_tokens_token_key" ON "push_tokens"("token");
CREATE INDEX "push_tokens_userId_updatedAt_idx" ON "push_tokens"("userId", "updatedAt");
CREATE INDEX "push_tickets_createdAt_idx" ON "push_tickets"("createdAt");
CREATE INDEX "push_tickets_pushTokenId_idx" ON "push_tickets"("pushTokenId");

ALTER TABLE "push_tokens"
ADD CONSTRAINT "push_tokens_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "push_tickets"
ADD CONSTRAINT "push_tickets_pushTokenId_fkey"
FOREIGN KEY ("pushTokenId") REFERENCES "push_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;
