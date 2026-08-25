-- Acertar o código passa a criar um pedido, não uma sessão: quem está no computador
-- precisa aprovar, e vê qual aparelho está pedindo. Colunas anuláveis para os códigos
-- que já estão em voo continuarem válidos durante a atualização.
ALTER TABLE "device_codes" ADD COLUMN "claimedAt" TIMESTAMP(3);
ALTER TABLE "device_codes" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "device_codes" ADD COLUMN "deniedAt" TIMESTAMP(3);
ALTER TABLE "device_codes" ADD COLUMN "deviceName" TEXT;
ALTER TABLE "device_codes" ADD COLUMN "requestSecretHash" TEXT;
