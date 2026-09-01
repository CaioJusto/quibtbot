ALTER TABLE "runs" ADD COLUMN "routineId" TEXT;

CREATE INDEX "runs_routineId_createdAt_idx" ON "runs"("routineId", "createdAt");

ALTER TABLE "runs"
ADD CONSTRAINT "runs_routineId_fkey"
FOREIGN KEY ("routineId") REFERENCES "routines"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
