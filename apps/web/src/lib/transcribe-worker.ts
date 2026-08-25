/// <reference lib="webworker" />
import { pipeline } from "@huggingface/transformers";

/**
 * O modelo roda aqui dentro, num worker, para a conversa não travar enquanto ele pensa.
 * É Whisper convertido para ONNX: baixa uma vez do Hugging Face (uns 75 MB), fica no cache
 * do navegador e depois disso funciona sem rede. O áudio nunca sai desta máquina.
 */

type Task = { id: string; audio: Float32Array; language?: string };

let transcriber: Awaited<ReturnType<typeof pipeline>> | null = null;
let loading: Promise<unknown> | null = null;

/** WebGPU quando existe; senão WASM, que é mais lento mas roda em qualquer lugar. */
async function hasWebGPU(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return Boolean(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function load() {
  if (transcriber) return transcriber;
  if (!loading) {
    loading = (async () => {
      const device = (await hasWebGPU()) ? "webgpu" : "wasm";
      postMessage({ type: "loading", device });
      transcriber = await pipeline(
        "automatic-speech-recognition",
        // O `base` multilíngue entende português; o `tiny` erra demais fora do inglês.
        "onnx-community/whisper-base",
        {
          device,
          progress_callback: (progress: { status?: string; progress?: number }) => {
            if (progress.status === "progress" && typeof progress.progress === "number") {
              postMessage({ type: "progress", percent: Math.round(progress.progress) });
            }
          },
        },
      );
      return transcriber;
    })().catch((error) => {
      loading = null;
      throw error;
    });
  }
  return loading;
}

self.onmessage = async (event: MessageEvent<Task>) => {
  const { id, audio, language } = event.data;
  try {
    const run = (await load()) as (
      input: Float32Array,
      options: Record<string, unknown>,
    ) => Promise<{ text?: string }>;
    const output = await run(audio, {
      // Dizer o idioma evita o palpite errado em gravações curtas.
      language: language ?? "pt",
      task: "transcribe",
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    postMessage({ type: "done", id, text: (output.text ?? "").trim() });
  } catch (error) {
    postMessage({ type: "error", id, message: String(error) });
  }
};
