import type { ApprovalDecision, PendingApproval } from "@quibt/core";

/** What the model is told when a pause ends its turn; subclasses say what is really awaited. */
export const APPROVAL_WAIT_TEXT = "Waiting for the user's approval.";

export class ApprovalPause extends Error {
  /** Goes into the tool result and therefore into the history: it has to be true. */
  readonly waitingText: string = APPROVAL_WAIT_TEXT;

  constructor() {
    super("approval-pause");
    this.name = "ApprovalPause";
  }
}

export function approvalCheckpoint(pending: PendingApproval, decision?: ApprovalDecision): string {
  return JSON.stringify({ pendingApproval: pending, decision });
}

/**
 * O turno final de um run que voltou de uma aprovação.
 *
 * O histórico já traz o que a ferramenta devolveu; repetir o pedido original
 * aqui faria o modelo executá-lo de novo, e o mesmo card de aprovação voltaria.
 */
export const RESUME_AFTER_APPROVAL_PROMPT =
  "The approval you were waiting for has been answered and the tool result is in the history above. Continue from there and answer the user's original request. Do not call the same tool again for work that already ran.";

/**
 * Que texto vai como último turno do modelo.
 *
 * Num run novo é o pedido da pessoa. Num run que acabou de sair de uma
 * aprovação, mandar o pedido de novo era o que fazia o bot pedir permissão para
 * o mesmo comando sem parar.
 */
export function promptForRun(taskPrompt: string, resumedAfterApproval: boolean): string {
  return resumedAfterApproval ? RESUME_AFTER_APPROVAL_PROMPT : taskPrompt;
}
