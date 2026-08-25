-- The deployment owner can paste a Composio key in the app instead of setting COMPOSIO_API_KEY.
ALTER TABLE "deployment_settings" ADD COLUMN "composioApiKeyCipher" TEXT;
