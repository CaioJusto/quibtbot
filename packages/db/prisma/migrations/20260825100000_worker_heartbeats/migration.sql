-- O worker passa aqui a cada ~15 s. A API lê a linha mais recente para dizer se há
-- alguém vivo para pegar a fila; um run parado sem batimento vira erro em vez de silêncio.
CREATE TABLE "worker_heartbeats" (
  "id" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "seenAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "worker_heartbeats_seenAt_idx" ON "worker_heartbeats"("seenAt");
