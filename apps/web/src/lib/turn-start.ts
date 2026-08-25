import type { ThreadMessage } from "@quibt/contracts";

/**
 * O runtime abre cada turno com um progresso "Trabalhando…" antes da primeira
 * palavra. Esse texto não é resposta: a conversa não o mostra como bolha, e o
 * Shell não pode tratá-lo como "o bot já começou a responder" — senão nem a
 * bolha de espera nem o marcador aparecem e a tela fica muda enquanto o run corre.
 */
const TURN_START_MARKERS = new Set(["working…", "working...", "trabalhando…", "trabalhando..."]);

export function isTurnStartMarker(text: string): boolean {
  return TURN_START_MARKERS.has(text.trim().toLowerCase());
}

/** Verdadeiro quando a mensagem tem conteúdo de resposta, não só o marcador de início. */
export function isAnsweringMessage(message: Pick<ThreadMessage, "role" | "blocks">): boolean {
  if (message.role !== "bot") return false;
  return message.blocks.some(
    (block) => !(block.kind === "progress" && isTurnStartMarker(block.text)),
  );
}
