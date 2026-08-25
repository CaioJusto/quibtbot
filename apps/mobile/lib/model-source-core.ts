export type ModelCredential = {
  id: string;
  provider: string;
  label: string;
  isDefault: boolean;
};

export type ModelCatalogEntry = {
  provider: string;
  providerName?: string;
  id: string;
  label?: string;
  oauthLabel?: string;
  signIn?: "device-code";
  auth?: "api-key" | "oauth" | "both";
  subscription?: boolean;
};

export type SignInOption = {
  provider: string;
  id: string;
  label: string;
};

/** One button per provider that supports the device-code subscription login. */
export function deviceSignInOptions(catalog: ModelCatalogEntry[]): SignInOption[] {
  const seen = new Map<string, SignInOption>();
  for (const entry of catalog) {
    if (entry.signIn !== "device-code" || seen.has(entry.provider)) continue;
    seen.set(entry.provider, {
      provider: entry.provider,
      id: entry.id,
      label: entry.oauthLabel ?? entry.providerName ?? entry.provider,
    });
  }
  return [...seen.values()];
}

/** What is paying for models right now: the default credential, or the edition fallback. */
export function currentSourceLabel(
  credentials: ModelCredential[],
  edition: "oss" | "cloud" = "oss",
): string {
  return (
    credentials.find((cred) => cred.isDefault)?.label ??
    (edition === "cloud" ? "Tokens do plano Quibt" : "Nenhuma chave ainda")
  );
}

export function usingOwnCredential(credentials: ModelCredential[]): boolean {
  return credentials.some((cred) => cred.isDefault);
}

/**
 * Open Source sells no tokens, so the card must not claim a monthly Quibt quota.
 * Mirrors apps/web/src/lib/edition-client.ts; keep the two in step.
 */
export function modelSourceBody(hasOwnCredential: boolean, edition: "oss" | "cloud"): string {
  if (hasOwnCredential) {
    return edition === "cloud"
      ? "Seus bots usam a credencial acima — o uso sai da sua assinatura ou chave, não dos tokens do plano."
      : "Seus bots usam a credencial acima. O uso sai da sua assinatura ou chave.";
  }
  return edition === "cloud"
    ? "Seus bots usam a cota mensal de tokens do plano Quibt."
    : "Seus bots usam a chave configurada no .env deste deploy. Conecte a sua para trocar.";
}

export function planSwitchLabel(edition: "oss" | "cloud"): string {
  return edition === "cloud" ? "Voltar aos tokens do plano" : "Voltar à chave do deploy";
}

export function planSwitchDone(edition: "oss" | "cloud"): string {
  return edition === "cloud"
    ? "Seus bots voltaram a usar os tokens do plano Quibt."
    : "Seus bots voltaram a usar a chave configurada no .env deste deploy.";
}
