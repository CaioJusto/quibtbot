import type { PrismaClient } from "@quibt/db";
import type { EncryptedSecretStore } from "./secrets.js";

/**
 * The Composio key the deployment owner pasted in Plugins. Both the API (catalog,
 * OAuth) and the worker (tool calls) read it the same way, so a key saved in the
 * app reaches the bots without COMPOSIO_API_KEY or a restart.
 */
export function storedComposioKeyLoader(
  prisma: PrismaClient,
  secrets: Pick<EncryptedSecretStore, "load">,
): () => Promise<string | undefined> {
  return async () => {
    const settings = await prisma.deploymentSettings
      .findUnique({ where: { id: "default" }, select: { composioApiKeyCipher: true } })
      .catch(() => null);
    if (!settings?.composioApiKeyCipher) return undefined;
    try {
      return secrets.load(settings.composioApiKeyCipher);
    } catch {
      return undefined;
    }
  };
}
