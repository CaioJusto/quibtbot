-- Só o uso de verdade renova o controle. O heartbeat de uma aba deixada aberta empurrava o
-- prazo a cada 60 s e o bot parado em `waiting_takeover` nunca recuperava o computador;
-- agora o heartbeat só renova quando houve tecla ou clique depois da última renovação.
-- AlterTable
ALTER TABLE "desktop_sessions" ADD COLUMN "controlLastInputAt" TIMESTAMP(3);
