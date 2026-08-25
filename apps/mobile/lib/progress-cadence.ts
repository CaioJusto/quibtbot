import type { ThreadEvent } from "./api";

/**
 * Ritmo com que a resposta do bot aparece na tela.
 *
 * O servidor publica o texto **acumulado** a cada pedaço (`thread.progress`), e o app
 * pintava cada um na hora: numa rajada de tokens eram dezenas de re-renders em poucos
 * milissegundos — a lista tremia, o "lag" que se sente. Como cada progress já traz o
 * texto inteiro até ali, dá para guardar só o mais recente e revelar num compasso fixo:
 * mais suave, e de propósito um tico mais calmo. Eventos estruturais (mensagem final,
 * run concluído, fio limpo) não podem esperar — descarregam o progress pendente e se
 * aplicam na hora, então nada some nem troca de ordem.
 */
export const PROGRESS_FLUSH_MS = 60;

/** `thread.progress` é o único evento que se acumula; todo o resto aplica imediatamente. */
export function isProgressEvent(type: string): boolean {
  return type === "thread.progress";
}

export interface ProgressCadence {
  /** Recebe um evento do fio; decide entre bufferizar (progress) ou aplicar já. */
  push: (event: ThreadEvent) => void;
  /** Cancela o timer pendente. Chamar ao desmontar a tela. */
  dispose: () => void;
}

/**
 * `apply` muda o estado da tela; `schedule`/`cancel` são o timer (injetáveis para teste).
 * O progress mais recente vence — texto acumulado, então intermediários são redundantes.
 */
export function createProgressCadence(
  apply: (event: ThreadEvent) => void,
  options: {
    schedule?: (fn: () => void, ms: number) => unknown;
    cancel?: (handle: unknown) => void;
    flushMs?: number;
  } = {},
): ProgressCadence {
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel =
    options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const flushMs = options.flushMs ?? PROGRESS_FLUSH_MS;

  let pending: ThreadEvent | null = null;
  let timer: unknown = null;

  const flush = () => {
    timer = null;
    if (!pending) return;
    const event = pending;
    pending = null;
    apply(event);
  };

  return {
    push(event) {
      if (isProgressEvent(event.type)) {
        pending = event;
        if (timer === null) timer = schedule(flush, flushMs);
        return;
      }
      // Estrutural: o que estava bufferizado tem de sair antes, na ordem certa.
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      if (pending) {
        const event0 = pending;
        pending = null;
        apply(event0);
      }
      apply(event);
    },
    dispose() {
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      pending = null;
    },
  };
}
