-- Voz (TTS): configuração por bot. A autenticação reutiliza a credencial OAuth
-- openai-codex já guardada em user_model_credentials; não existe um segundo cofre.
ALTER TABLE "bots" ADD COLUMN "voiceEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bots" ADD COLUMN "voiceAutoSpeak" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bots" ADD COLUMN "voiceId" TEXT NOT NULL DEFAULT '';
