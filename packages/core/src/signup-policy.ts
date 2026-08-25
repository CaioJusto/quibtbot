export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function emailAllowed(email: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const normalized = email.trim().toLowerCase();
  const domain = normalized.split("@")[1];
  return allowlist.some((entry) => {
    if (entry.startsWith("@")) return domain === entry.slice(1);
    return normalized === entry;
  });
}

/**
 * O cadastro nasce fechado: sem `SIGNUPS_ENABLED` no ambiente, ninguém cria conta além do
 * primeiro dono (que entra pelo código do instalador). Numa VPS pública, o padrão aberto
 * deixava qualquer pessoa ganhar um computador com Chrome e gastar a chave do dono.
 */
export function signupsOpen(enabled: string | undefined): boolean {
  if (enabled === undefined) return false;
  return enabled !== "false" && enabled !== "0";
}
