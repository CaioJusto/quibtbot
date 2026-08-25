import type { QuibtEdition } from "@quibt/core";

/**
 * Which edition this deploy is. The client never decides on its own: `health` first, then the
 * authenticated `me`, and only then a guess from the billing snapshot.
 */
export function resolveClientEdition(input: {
  health?: { edition?: QuibtEdition } | null;
  me?: { edition?: QuibtEdition } | null;
  billing?: { enabled?: boolean } | null;
}): QuibtEdition {
  return input.health?.edition ?? input.me?.edition ?? (input.billing?.enabled ? "cloud" : "oss");
}

/** The label next to "Modelos e tokens": who is paying for the model right now. */
export function defaultSourceLabel(
  credentials: Array<{ label: string; isDefault: boolean }>,
  edition: QuibtEdition,
): string {
  const own = credentials.find((cred) => cred.isDefault)?.label;
  if (own) return own;
  return edition === "cloud" ? "Tokens do plano Quibt" : "Nenhuma chave sua";
}

/** Open Source sells no tokens, so it must not claim a monthly Quibt quota. */
export function modelSourceBody(hasOwnCredential: boolean, edition: QuibtEdition): string {
  if (hasOwnCredential) {
    return edition === "cloud"
      ? "Seus bots usam a credencial acima — o uso sai da sua assinatura ou chave, não dos tokens do plano."
      : "Seus bots usam a credencial acima. O uso sai da sua assinatura ou chave.";
  }
  return edition === "cloud"
    ? "Seus bots usam a cota mensal de tokens do plano Quibt."
    : "Seus bots usam a chave configurada no .env deste deploy. Conecte a sua para trocar.";
}

export function planSwitchLabel(edition: QuibtEdition): string {
  return edition === "cloud" ? "Voltar aos tokens do plano" : "Voltar à chave do deploy";
}

export function planSwitchDone(edition: QuibtEdition): string {
  return edition === "cloud"
    ? "Seus bots voltaram a usar os tokens do plano Quibt."
    : "Seus bots voltaram a usar a chave configurada no .env deste deploy.";
}
