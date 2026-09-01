/**
 * Falar respostas: manda o texto para `POST /tts` e toca o áudio que volta.
 *
 * O navegador tem `speechSynthesis`, mas é a mesma armadilha da ditado antigo: dentro do
 * Electron ele existe e não responde. O caminho aqui é o mesmo dos anexos — bytes pela
 * API, um `<audio>` de cada vez, e a chave do provedor nunca desce ao cliente.
 */

export type SpeechStatus = "idle" | "loading" | "playing";

export interface SpeechState {
  status: SpeechStatus;
  /** A mensagem sendo falada (ou carregada) agora; `null` em silêncio. */
  messageId: string | null;
}

export interface SpeechPlayer {
  speak(input: { messageId: string; botId: string; text: string }): Promise<void>;
  stop(): void;
  state(): SpeechState;
  subscribe(listener: (state: SpeechState) => void): () => void;
}

/**
 * O que de um Markdown vale a pena ouvir. Blocos de código viram um aviso curto em vez
 * de minutos de sintaxe soletrada; links ficam só com o rótulo; a pontuação estrutural
 * (cercas, crases, asteriscos, tabelas) sai.
 */
export function speakableText(markdown: string): string {
  let text = markdown;
  text = text.replace(/```[\s\S]*?```/g, " (trecho de código) ");
  text = text.replace(/`([^`\n]+)`/g, "$1");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  text = text.replace(/^\s*>\s?/gm, "");
  text = text.replace(/\|/g, " ");
  text = text.replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1");
  text = text.replace(/^[-=]{3,}\s*$/gm, "");
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function createSpeechPlayer(): SpeechPlayer {
  let state: SpeechState = { status: "idle", messageId: null };
  let audio: HTMLAudioElement | null = null;
  let objectUrl: string | null = null;
  let generation = 0;
  const listeners = new Set<(state: SpeechState) => void>();

  const emit = (next: SpeechState) => {
    state = next;
    for (const listener of listeners) listener(state);
  };

  const cleanup = () => {
    if (audio) {
      audio.pause();
      audio.src = "";
      audio = null;
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  };

  const stop = () => {
    generation += 1;
    cleanup();
    emit({ status: "idle", messageId: null });
  };

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop,
    async speak({ messageId, botId, text }) {
      // Falar de novo a mensagem que já toca é o gesto de parar.
      if (state.messageId === messageId && state.status !== "idle") {
        stop();
        return;
      }
      generation += 1;
      const mine = generation;
      cleanup();
      emit({ status: "loading", messageId });
      const spoken = speakableText(text);
      if (!spoken) {
        if (generation === mine) stop();
        return;
      }
      let blob: Blob;
      try {
        const res = await fetch("/tts", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ botId, text: spoken }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { message?: string } | null;
          throw new Error(body?.message ?? "Não deu para gerar o áudio.");
        }
        blob = await res.blob();
      } catch (error) {
        if (generation === mine) stop();
        throw error;
      }
      if (generation !== mine) return;
      objectUrl = URL.createObjectURL(blob);
      audio = new Audio(objectUrl);
      audio.onended = () => {
        if (generation === mine) stop();
      };
      audio.onerror = () => {
        if (generation === mine) stop();
      };
      emit({ status: "playing", messageId });
      try {
        await audio.play();
      } catch {
        // Autoplay bloqueado (nenhum gesto ainda): silêncio é melhor que erro na tela.
        if (generation === mine) stop();
      }
    },
  };
}
