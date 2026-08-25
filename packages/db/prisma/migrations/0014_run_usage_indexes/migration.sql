CREATE INDEX IF NOT EXISTS "runs_botId_status_idx" ON "runs"("botId", "status");
CREATE INDEX IF NOT EXISTS "runs_threadId_status_idx" ON "runs"("threadId", "status");
CREATE INDEX IF NOT EXISTS "usage_records_workspaceId_paidBy_createdAt_idx" ON "usage_records"("workspaceId", "paidBy", "createdAt");
CREATE INDEX IF NOT EXISTS "events_runId_type_idx" ON "events"("runId", "type");
