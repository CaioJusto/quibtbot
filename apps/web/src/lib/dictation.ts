export function appendDictatedText(current: string, chunk: string): string {
  const next = chunk.trim();
  if (!next) return current;
  if (!current.trim()) return next;
  return /\s$/.test(current) ? `${current}${next}` : `${current} ${next}`;
}

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort?: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};

type SpeechWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
};

export function speechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const speechWindow = window as SpeechWindow;
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

export function createDictationSession(
  onFinal: (text: string) => void,
  onEnd?: () => void,
): {
  start: () => boolean;
  stop: () => void;
  supported: boolean;
} {
  const Ctor = speechRecognitionCtor();
  if (!Ctor) {
    return { start: () => false, stop: () => undefined, supported: false };
  }

  let rec: SpeechRecognitionLike | null = null;
  let stopping = false;

  return {
    supported: true,
    start() {
      rec?.abort?.();
      stopping = false;
      rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = false;
      rec.lang = typeof navigator === "undefined" ? "en-US" : navigator.language || "en-US";
      rec.onresult = (event) => {
        const last = event.results[event.results.length - 1];
        const transcript = last?.[0]?.transcript ?? "";
        if (transcript) onFinal(transcript);
      };
      rec.onerror = () => undefined;
      rec.onend = () => {
        rec = null;
        if (!stopping) onEnd?.();
      };
      rec.start();
      return true;
    },
    stop() {
      stopping = true;
      rec?.stop();
      rec = null;
    },
  };
}
