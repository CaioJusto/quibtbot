/**
 * Modo trackpad: a superfície (o dedo no celular, o mouse preso na web) manda o
 * DESLOCAMENTO para o computador do bot, não uma posição. Este módulo é a parte pura,
 * compartilhada pelo app e pela web: juntar os movimentos num só por quadro, decidir
 * se soltar foi um clique, e traduzir uma tecla do navegador para o xdotool.
 */

export const TRACKPAD_CLICK_SLOP_PX = 8;

export type PointerDelta = { x: number; y: number };

type Scheduler = (callback: () => void) => number;

// O core também compila para Node (API): o quadro do navegador entra por globalThis, com
// um setTimeout no lugar quando não há tela.
const nextFrame: Scheduler = (callback) => {
  const g = globalThis as { requestAnimationFrame?: Scheduler };
  if (g.requestAnimationFrame) return g.requestAnimationFrame(callback);
  return setTimeout(callback, 16) as unknown as number;
};
const cancelFrame = (id: number) => {
  const g = globalThis as { cancelAnimationFrame?: (id: number) => void };
  if (g.cancelAnimationFrame) g.cancelAnimationFrame(id);
  else clearTimeout(id);
};

/** Um RPC por quadro, com a soma dos deltas — não um por evento de ponteiro. */
export function createPointerMoveCoalescer(
  send: (delta: PointerDelta) => void,
  schedule: Scheduler = nextFrame,
  cancelScheduled: (id: number) => void = cancelFrame,
) {
  let scheduled: number | null = null;
  let x = 0;
  let y = 0;

  const emit = () => {
    scheduled = null;
    const delta = { x, y };
    x = 0;
    y = 0;
    if (delta.x !== 0 || delta.y !== 0) send(delta);
  };

  return {
    add(delta: PointerDelta) {
      x += delta.x;
      y += delta.y;
      if (scheduled === null) scheduled = schedule(emit);
    },
    flush() {
      if (scheduled !== null) cancelScheduled(scheduled);
      emit();
    },
    cancel() {
      if (scheduled !== null) cancelScheduled(scheduled);
      scheduled = null;
      x = 0;
      y = 0;
    },
  };
}

/** Soltar depois de quase não mexer é um clique; depois de arrastar, não é nada. */
export function trackpadReleaseAction(movedPx: number): "click" | null {
  return movedPx <= TRACKPAD_CLICK_SLOP_PX ? "click" : null;
}

export type TrackpadKeyEvent = {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
};

export type TrackpadKeyInput =
  | { kind: "key"; key: string; modifiers: string[] }
  | { kind: "clipboard"; text: string };

const NAMED_KEYS: Record<string, string> = {
  Enter: "Return",
  Escape: "Escape",
  Backspace: "BackSpace",
  Tab: "Tab",
  Delete: "Delete",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Home: "Home",
  End: "End",
  PageUp: "Page_Up",
  PageDown: "Page_Down",
  Insert: "Insert",
};

/**
 * Uma tecla apertada na web vira o que o computador do bot entende. Caractere
 * imprimível sem ctrl/alt/cmd é digitado como texto (`xdotool type`), o que cobre
 * acento, ç e pontuação sem tabela de keysym; o resto vai como tecla nomeada com os
 * modificadores. Só modificador apertado não é nada.
 */
export function trackpadKeyInput(event: TrackpadKeyEvent): TrackpadKeyInput | null {
  const { key } = event;
  if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") return null;
  if (key === "Unidentified" || key === "Dead") return null;
  const modifiers = [
    event.ctrlKey ? "ctrl" : null,
    event.altKey ? "alt" : null,
    event.metaKey ? "meta" : null,
  ].filter((entry): entry is string => entry !== null);

  const printable = [...key].length === 1;
  if (printable) {
    if (modifiers.length === 0) return { kind: "clipboard", text: key };
    // ctrl+c chega como "c"; com shift o navegador já manda "C". O xdotool quer a
    // tecla base e o shift explícito.
    const base = key.length === 1 && key !== key.toLowerCase() ? key.toLowerCase() : key;
    return {
      kind: "key",
      key: base === " " ? "space" : base,
      modifiers: event.shiftKey ? [...modifiers, "shift"] : modifiers,
    };
  }

  const named = NAMED_KEYS[key] ?? (/^F\d{1,2}$/.test(key) ? key : null);
  if (!named) return null;
  return {
    kind: "key",
    key: named,
    modifiers: event.shiftKey ? [...modifiers, "shift"] : modifiers,
  };
}
