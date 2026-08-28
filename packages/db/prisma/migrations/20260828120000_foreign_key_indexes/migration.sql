-- Apagar um bot ou uma conta arrastava a base atrás de si. Toda chave estrangeira com
-- `onDelete: Cascade` faz o Postgres rodar uma consulta na tabela filha por LINHA apagada
-- do pai; sem índice na coluna da chave, cada uma dessas consultas varre a tabela filha
-- inteira. Apagar um bot com 10 mil runs disparava 10 mil varreduras de `runs` (por
-- `runs.taskId`) e 10 mil de `usage_records` (por `usage_records.runId`).
--
-- Medido no Postgres 16 de teste, 1 bot com 10 mil runs (EXPLAIN ANALYZE do
-- `DELETE FROM bots`): 1501 ms no total, dos quais 700 ms no gatilho `runs_taskId_fkey`
-- e 643 ms no `usage_records_runId_fkey` — 89% do custo em duas chaves sem índice. O
-- custo cresce com linhas apagadas x tamanho da tabela filha, então em base grande ele
-- estoura o prazo da transação. Com os índices abaixo, os mesmos dois gatilhos caem para
-- a casa das dezenas de ms.
--
-- São as 14 chaves estrangeiras que ainda não tinham índice de apoio. As demais já
-- estavam cobertas por um índice existente com a coluna na frente.

-- CreateIndex
CREATE INDEX "invitation_inviterId_idx" ON "invitation"("inviterId");

-- CreateIndex
CREATE INDEX "tasks_botId_idx" ON "tasks"("botId");

-- CreateIndex
CREATE INDEX "tasks_threadId_idx" ON "tasks"("threadId");

-- CreateIndex
CREATE INDEX "runs_taskId_idx" ON "runs"("taskId");

-- CreateIndex
CREATE INDEX "external_effects_workspaceId_idx" ON "external_effects"("workspaceId");

-- CreateIndex
CREATE INDEX "routines_botId_idx" ON "routines"("botId");

-- CreateIndex
CREATE INDEX "routines_groupId_idx" ON "routines"("groupId");

-- CreateIndex
CREATE INDEX "memory_documents_botId_idx" ON "memory_documents"("botId");

-- CreateIndex
CREATE INDEX "agent_homes_workspaceId_idx" ON "agent_homes"("workspaceId");

-- CreateIndex
CREATE INDEX "browser_profiles_workspaceId_idx" ON "browser_profiles"("workspaceId");

-- CreateIndex
CREATE INDEX "artifacts_botId_idx" ON "artifacts"("botId");

-- CreateIndex
CREATE INDEX "usage_records_botId_idx" ON "usage_records"("botId");

-- CreateIndex
CREATE INDEX "usage_records_runId_idx" ON "usage_records"("runId");

-- CreateIndex
CREATE INDEX "webhooks_botId_idx" ON "webhooks"("botId");
