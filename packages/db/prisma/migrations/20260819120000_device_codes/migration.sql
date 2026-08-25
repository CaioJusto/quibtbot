-- Entrar em outro aparelho por código curto, sem e-mail nem senha.
CREATE TABLE "device_codes" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "device_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "device_codes_codeHash_key" ON "device_codes"("codeHash");
CREATE INDEX "device_codes_userId_idx" ON "device_codes"("userId");

ALTER TABLE "device_codes" ADD CONSTRAINT "device_codes_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
