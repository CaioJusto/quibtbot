/**
 * Nota de voz. O ditado antigo pedia reconhecimento de fala ao navegador, o que no app
 * de desktop existe mas nunca responde: o botão acendia, o reconhecimento morria no
 * primeiro evento e nada era gravado nem enviado. Aqui o áudio é gravado pelo próprio
 * navegador — `MediaRecorder` funciona igual no Chrome e no Electron — e vira um arquivo.
 */

export type VoiceRecorder = {
  start: () => Promise<void>;
  /** Encerra e devolve o áudio; `null` se nada foi gravado. */
  stop: () => Promise<{ blob: Blob; mimeType: string; seconds: number } | null>;
  /** Desiste: solta o microfone e joga fora o que foi gravado. */
  cancel: () => void;
};

/** O primeiro formato que o navegador aceitar; todos abrem no fio e no modelo. */
export function pickMimeType(supported: (type: string) => boolean = canRecord): string {
  const wanted = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return wanted.find(supported) ?? "";
}

function canRecord(type: string): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof MediaRecorder.isTypeSupported === "function" &&
    MediaRecorder.isTypeSupported(type)
  );
}

export function voiceSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== "undefined"
  );
}

/** `webm` para `audio/webm;codecs=opus`, e assim por diante. */
export function extensionFor(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim() ?? "";
  if (base === "audio/mp4") return "m4a";
  if (base === "audio/ogg") return "ogg";
  if (base === "audio/wav") return "wav";
  return "webm";
}

export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function createVoiceRecorder(): VoiceRecorder {
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: Blob[] = [];
  let startedAt = 0;

  function release() {
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    recorder = null;
    chunks = [];
  }

  return {
    async start() {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickMimeType();
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      // Um pedaço por segundo: se a janela fechar no meio, o que já passou está gravado.
      recorder.start(1000);
      startedAt = Date.now();
    },

    stop() {
      const active = recorder;
      if (!active || active.state === "inactive") {
        release();
        return Promise.resolve(null);
      }
      const mimeType = active.mimeType || pickMimeType() || "audio/webm";
      const seconds = (Date.now() - startedAt) / 1000;
      return new Promise((resolve) => {
        active.onstop = () => {
          const blob = new Blob(chunks, { type: mimeType });
          release();
          resolve(blob.size > 0 ? { blob, mimeType, seconds } : null);
        };
        active.stop();
      });
    },

    cancel() {
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stop();
      }
      release();
    },
  };
}
