import type { SandboxFactoryOptions } from "./sandbox-factory.js";
import type { EncryptedSecretStore } from "./secrets.js";

export interface SavedSandboxSettings {
  sandboxProvider?: string | null;
  sandboxEndpoint?: string | null;
  sandboxCredentialCipher?: string | null;
}

/** Merge BYOK / remote supervisor settings onto the process env options. */
export function sandboxOptionsFromSettings(
  settings: SavedSandboxSettings | null | undefined,
  secrets: Pick<EncryptedSecretStore, "load">,
  env: SandboxFactoryOptions,
): SandboxFactoryOptions {
  const extra: Partial<SandboxFactoryOptions> = {};
  const kind = settings?.sandboxProvider ?? "";
  const key = settings?.sandboxCredentialCipher
    ? secrets.load(settings.sandboxCredentialCipher)
    : undefined;
  if (kind === "e2b" && key) extra.e2bApiKey = key;
  if (kind === "box" && key) extra.boxApiKey = key;
  if (kind === "remote-supervisor") {
    if (settings?.sandboxEndpoint) extra.remoteSupervisorUrl = settings.sandboxEndpoint;
    if (key) extra.remoteSupervisorToken = key;
  }
  return { ...env, ...extra };
}
