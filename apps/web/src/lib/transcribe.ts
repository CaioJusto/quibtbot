/**
 * Transcrição do recado de voz, na própria máquina.
 *
 * O modelo é carregado só quando alguém grava pela primeira vez — ele e o runtime pesam
 * demais para entrarem no pacote que abre o app. Se o carregamento falhar (sem rede na
 * primeira vez, navegador antigo), a nota de voz segue sozinha: o áudio já é o recado.
 */

/** Whisper foi treinado em 16 kHz; qualquer outra taxa sai embolada. */
export const WHISPER_SAMPLE_RATE = 16_000;

export type TranscribeStatus =
  | { state: "idle" }
  | { state: "loading"; percent?: number }
  | { state: "working" };

/** Mistura os canais e reamostra para o que o modelo espera. */
export function toMonoAt16k(buffer: AudioBuffer): Float32Array {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) =>
    buffer.getChannelData(i),
  );
  const mono = new Float32Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i] ?? 0;
    mono[i] = sum / channels.length;
  }
  if (buffer.sampleRate === WHISPER_SAMPLE_RATE) return mono;
  return resample(mono, buffer.sampleRate, WHISPER_SAMPLE_RATE);
}

/** Reamostragem linear: basta para fala, e não traz uma biblioteca de áudio junto. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input;
  const ratio = from / to;
  const output = new Float32Array(Math.max(1, Math.round(input.length / ratio)));
  for (let i = 0; i < output.length; i++) {
    const at = i * ratio;
    const low = Math.floor(at);
    const high = Math.min(low + 1, input.length - 1);
    const weight = at - low;
    output[i] = (input[low] ?? 0) * (1 - weight) + (input[high] ?? 0) * weight;
  }
  return output;
}

/** O que o modelo devolve vem com espaços sobrando e, às vezes, marcações de silêncio. */
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

let worker: Worker | null = null;
let nextId = 0;

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./transcribe-worker.ts", import.meta.url), { type: "module" });
  }
  return worker;
}

export function transcriptionSupported(): boolean {
  return typeof Worker !== "undefined" && typeof AudioContext !== "undefined";
}

/**
 * Transcreve um áudio já gravado. Devolve o texto, ou `null` quando não deu — e não dar
 * certo aqui nunca é motivo para perder o recado.
 */
export async function transcribe(
  blob: Blob,
  options: { language?: string; onStatus?: (status: TranscribeStatus) => void } = {},
): Promise<string | null> {
  if (!transcriptionSupported()) return null;
  const { onStatus } = options;
  try {
    const context = new AudioContext({ sampleRate: WHISPER_SAMPLE_RATE });
    let audio: Float32Array;
    try {
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      audio = toMonoAt16k(decoded);
    } finally {
      void context.close();
    }
    if (!audio.length) return null;

    const active = ensureWorker();
    const id = String(++nextId);
    onStatus?.({ state: "loading" });
    return await new Promise<string | null>((resolve) => {
      const onMessage = (event: MessageEvent) => {
        const data = event.data as {
          type: string;
          id?: string;
          text?: string;
          percent?: number;
        };
        if (data.type === "progress") {
          onStatus?.({ state: "loading", percent: data.percent });
          return;
        }
        if (data.type === "loading") {
          onStatus?.({ state: "loading" });
          return;
        }
        if (data.id !== id) return;
        active.removeEventListener("message", onMessage);
        onStatus?.({ state: "idle" });
        resolve(data.type === "done" ? cleanTranscript(data.text ?? "") || null : null);
      };
      active.addEventListener("message", onMessage);
      onStatus?.({ state: "working" });
      active.postMessage({ id, audio, language: options.language ?? "pt" }, [audio.buffer]);
    });
  } catch {
    onStatus?.({ state: "idle" });
    return null;
  }
}
