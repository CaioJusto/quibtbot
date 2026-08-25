/**
 * O que a pessoa lê quando uma chamada falha.
 *
 * O oRPC devolve o código da falha como mensagem quando o servidor não escreveu
 * uma — e "Forbidden" sozinho, no meio do onboarding, não diz nem o que houve nem
 * o que fazer. Aqui os códigos crus viram frases em português.
 */
const BY_CODE: Record<string, string> = {
  FORBIDDEN: "Só quem instalou o Quibt neste computador pode mudar esta configuração.",
  UNAUTHORIZED: "A sua sessão expirou. Entre de novo.",
  NOT_FOUND: "Não encontrei isso. Talvez tenha sido apagado.",
  CONFLICT: "Alguém mudou isso antes de você. Recarregue e tente de novo.",
  TIMEOUT: "O servidor demorou demais para responder.",
  TOO_MANY_REQUESTS: "Muitos pedidos seguidos. Espere um instante.",
  INTERNAL_SERVER_ERROR: "O servidor falhou nesta hora. Tente de novo.",
};

/**
 * O navegador chama de "Failed to fetch" tanto a queda do servidor quanto a falta de rede.
 * Mostrar isso cru na conversa não diz nada a quem só quer usar o bot.
 */
const NETWORK_MESSAGE = /failed to fetch|networkerror|load failed|connection (reset|closed)|err_/i;

export function isNetworkFailure(error: unknown): boolean {
  return error instanceof Error && NETWORK_MESSAGE.test(error.message);
}

export function errorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message.trim() : "";
  if (!raw) return fallback;
  if (isNetworkFailure(error)) {
    return "Perdi o contato com o seu Quibt. Verifique se o computador que o roda está ligado.";
  }
  if (/não tenho um modelo/i.test(raw)) return raw;
  if (/computador não ligou/i.test(raw)) return raw;
  const known = BY_CODE[raw.toUpperCase().replace(/\s+/g, "_")];
  if (known) return known;
  // Uma mensagem escrita pelo servidor já vem pronta para leitura; um código não.
  return /^[A-Z_ ]+$/.test(raw) ? fallback : raw;
}
