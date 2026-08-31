/**
 * O login com assinatura (ChatGPT, Copilot, SuperGrok) é um device code: a tela mostra
 * um código, a pessoa sai para o navegador, confirma, e volta. Enquanto isso a tela faz
 * poll em `completeOAuth`.
 *
 * No celular, sair para o Safari suspende o app: a requisição em voo morre e o fetch
 * rejeita com "network request failed" ou com o timeout do cliente. Isso não é uma
 * falha do login — o servidor continua esperando a OpenAI — e não pode virar erro na
 * tela, senão o polling para e a credencial nunca é salva. Só o que o servidor devolve
 * de fato (`status: "error"`) ou uma sessão expirada merecem interromper a espera.
 */
import { isTransientNetworkFailure } from "./network-errors.js";

export function shouldKeepWaitingForSubscription(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (code === "session_expired" || code === "UNAUTHORIZED") return false;
  return isTransientNetworkFailure(error);
}
