/**
 * Ditado como uma máquina de estados pura.
 *
 * O microfone do composer é ditado, não gravação: o que a pessoa fala vira texto no
 * campo, e ela manda quando quiser — igual ao teclado. O reconhecimento roda no próprio
 * aparelho (Speech no iOS, SpeechRecognizer no Android), então não depende de servidor
 * nem do modelo saber ouvir áudio. Antes o botão gravava um .m4a, anexava e avisava que
 * "transcrição não está configurada" — para quem usa, isso era "não funciona".
 */

export type VoicePhase =
  | "idle"
  | "requesting-permission"
  | "permission-denied"
  | "listening"
  | "error";

export type VoiceState = {
  phase: VoicePhase;
  error?: string;
};

export const initialVoiceState: VoiceState = { phase: "idle" };

export type VoiceEvent =
  | { type: "mic-press" }
  | { type: "permission-result"; granted: boolean }
  | { type: "listening-stopped" }
  | { type: "error"; message: string }
  | { type: "reset" };

export function permissionDeniedMessage(): string {
  return "Sem acesso ao microfone ou ao reconhecimento de fala. Libere os dois nos Ajustes do aparelho para ditar.";
}

export function voiceReducer(state: VoiceState, event: VoiceEvent): VoiceState {
  switch (event.type) {
    case "mic-press":
      return { phase: "requesting-permission" };
    case "permission-result":
      return event.granted
        ? { phase: "listening" }
        : { phase: "permission-denied", error: permissionDeniedMessage() };
    case "listening-stopped":
      return { phase: "idle" };
    case "error":
      return { phase: "error", error: event.message };
    case "reset":
      return initialVoiceState;
    default:
      return state;
  }
}

/** Bridges a native `PermissionResponse`-shaped result into the reducer's event. */
export function permissionEventFromResponse(response: { granted: boolean }): VoiceEvent {
  return { type: "permission-result", granted: response.granted };
}

/** Human copy for whatever the composer should show next to the mic button, or null when idle. */
export function voiceStatusMessage(state: VoiceState): string | null {
  if (state.phase === "permission-denied") return state.error ?? permissionDeniedMessage();
  if (state.phase === "listening") return "Ouvindo… fale; toque no quadrado quando terminar.";
  if (state.phase === "error") return state.error ?? "Não deu para ouvir. Tente de novo.";
  return null;
}

/**
 * O texto do campo enquanto a pessoa dita: o que já estava escrito antes de apertar o
 * microfone, mais a transcrição corrente (parcial ou final) — sem nunca colar duas
 * falas sem espaço nem apagar o que ela tinha digitado.
 */
export function dictatedDraft(base: string, transcript: string): string {
  const spoken = transcript.trim();
  if (!spoken) return base;
  const head = base.replace(/\s+$/, "");
  return head ? `${head} ${spoken}` : spoken;
}

/** Como o erro do reconhecedor vira uma frase para a pessoa. */
export function recognitionErrorMessage(code: string | undefined): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return permissionDeniedMessage();
    case "language-not-supported":
      return "Este aparelho não reconhece fala em português. Digite a mensagem.";
    case "network":
      return "O reconhecimento de fala precisou da internet e não conseguiu. Tente de novo.";
    case "no-speech":
      return "Não ouvi nada. Toque no microfone e fale.";
    case "audio-capture":
      return "Não consegui usar o microfone. Feche outro app que esteja gravando e tente de novo.";
    default:
      return "Não deu para ouvir. Tente de novo.";
  }
}
