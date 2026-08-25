const WORKING = new Set([
  "running",
  "queued",
  "leased",
  "waiting_input",
  "waiting_takeover",
  "booting",
]);

/** Green presence: the bot is in the middle of a turn. */
export function botIsOnline(status: string | null | undefined): boolean {
  return Boolean(status && WORKING.has(status));
}

/**
 * Inbox status for a bot: the active turn, or idle.
 *
 * O computador ligado entre um turno e outro já contou como "running" — e a bolinha
 * verde acendia com o bot parado, só porque o Xvfb ainda estava de pé. A regra é a de
 * quem olha a lista: verde é trabalhando, azul é mensagem que eu não li, e sem bolinha
 * é quieto. `computerState` fica aceito para não quebrar quem chama, mas não pesa.
 */
export function inboxBotStatus(input: {
  runStatus?: string | null;
  computerState?: string | null;
}): string {
  if (input.runStatus && WORKING.has(input.runStatus)) return input.runStatus;
  return "idle";
}

/**
 * A bolinha da lista: verde enquanto o bot trabalha sozinho; azul quando parou e é a
 * pessoa quem falta — pediu aprovação, pediu uma resposta, ou deixou mensagem nova.
 */
export function inboxPresence(input: {
  status?: string | null;
  unread?: boolean | null;
}): "working" | "attention" | null {
  if (input.status === "waiting_input" || input.status === "waiting_takeover") return "attention";
  if (input.status && WORKING.has(input.status)) return "working";
  if (input.unread) return "attention";
  return null;
}
