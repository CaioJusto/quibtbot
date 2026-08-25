import { connectLinkIsReachable, parseConnectDeepLink } from "@quibt/core";
import { claimPairToken, probeApiBase, saveApiBase } from "./api";

export type ConnectResult =
  | { ok: true; api: string; signedIn: boolean; name?: string }
  /**
   * O motivo importa para a tela: "não é um QR do Quibt" e "é do Quibt, mas não
   * alcancei o servidor" pedem coisas diferentes de quem está com o celular na mão.
   * Sem essa distinção, um QR gerado com endereço de loopback era acusado de falso.
   */
  | { ok: false; reason: "not-quibt"; api?: undefined }
  | { ok: false; reason: "loopback" | "unreachable" | "rejected"; api: string };

/**
 * O caminho único de todo QR e de todo link `quibt://connect`, venha ele da câmera do
 * app ou da câmera do sistema. Primeiro aponta o app para o servidor do link; depois,
 * se o link trouxer um código de emparelhamento, troca esse código por uma sessão e o
 * usuário entra sem digitar nada. Sem código, o app só fica no servidor certo.
 */
export async function applyConnectLink(raw: string): Promise<ConnectResult> {
  const parsed = parseConnectDeepLink(raw);
  if (!parsed) return { ok: false, reason: "not-quibt" };
  // Loopback aponta para este próprio celular: nem vale gastar a tentativa de rede.
  if (!connectLinkIsReachable(parsed.api)) {
    return { ok: false, reason: "loopback", api: parsed.api };
  }
  const probed = await probeApiBase(parsed.api).catch(() => ({
    ok: false as const,
    error: "Não alcançou o servidor",
  }));
  // A QR/deep link is untrusted input. Never switch the authentication server when its
  // health check failed: otherwise the next password submission could go to a phishing host.
  if (!probed.ok) return { ok: false, reason: "unreachable", api: parsed.api };
  const saved = await saveApiBase(probed.url);
  if (!saved.ok) return { ok: false, reason: "rejected", api: parsed.api };
  if (!parsed.pair) return { ok: true, api: saved.url, signedIn: false };
  const claimed = await claimPairToken(parsed.pair).catch(() => null);
  return claimed
    ? { ok: true, api: saved.url, signedIn: true, name: claimed.name }
    : { ok: true, api: saved.url, signedIn: false };
}

/** O que a pessoa lê na tela do leitor — o que fazer, não o nome do erro. */
export function connectFailureMessage(
  result: Extract<ConnectResult, { ok: false }>,
  platform?: "ios" | "android" | "web" | string,
): string {
  if (result.reason === "not-quibt") {
    return "Esse QR não é de um computador Quibt. Abra Conta → Conectar o celular.";
  }
  if (result.reason === "loopback") {
    return `Esse QR aponta para ${hostOf(result.api)}, que no celular é o próprio celular. Gere o QR pelo app do computador, que sabe o endereço da rede.`;
  }
  if (result.reason === "unreachable") {
    const permission =
      platform === "ios" ? " No iPhone, permita Rede Local em Ajustes → Quibt Bot." : "";
    return `Li o QR, mas não alcancei ${hostOf(result.api)}. Confira se o celular está na mesma rede desse computador.${permission}`;
  }
  return "Esse endereço não pôde ser guardado. Gere o QR de novo no computador.";
}

function hostOf(api: string): string {
  try {
    return new URL(api).host;
  } catch {
    return api;
  }
}
