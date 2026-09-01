/**
 * Voz (TTS): transforma uma resposta em áudio usando o token OAuth ChatGPT/Codex que
 * `models.connect` já guarda. Não há chave de voz nem segundo sistema de credenciais.
 * O endereço é fixo; nada aqui aceita URL fornecida pelo cliente.
 */

/**
 * Teto do texto falado por pedido. TTS cobra por caractere; uma resposta longa com
 * blocos de código inteiros viraria uma conta surpresa e minutos de áudio inúteis.
 */
export const MAX_TTS_INPUT_CHARS = 4_000;

export const TTS_SPEECH_TIMEOUT_MS = 45_000;

/** A voz usada quando o bot não escolheu uma. */
export const DEFAULT_TTS_VOICE = "alloy";

export interface TtsOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type TtsSpeechResult =
  | { ok: true; audio: ArrayBuffer; mimeType: string }
  | { ok: false; status: number; message: string };

export async function synthesizeSpeech(
  input: { accessToken: string; accountId?: string; voiceId: string; text: string },
  options: TtsOptions = {},
): Promise<TtsSpeechResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? TTS_SPEECH_TIMEOUT_MS;
  const text = input.text.trim().slice(0, MAX_TTS_INPUT_CHARS);
  if (!text) return { ok: false, status: 400, message: "Não há texto para falar." };
  const accessToken = input.accessToken.trim();
  if (!accessToken) {
    return { ok: false, status: 409, message: "Entre com ChatGPT Plus/Pro nos ajustes." };
  }
  const voiceId = input.voiceId.trim() || DEFAULT_TTS_VOICE;
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  };
  if (input.accountId) headers["chatgpt-account-id"] = input.accountId;
  const request = {
    url: "https://api.openai.com/v1/audio/speech",
    headers,
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: voiceId,
      input: text,
      response_format: "mp3",
    }),
  };

  let res: Response;
  try {
    res = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return {
      ok: false,
      status: 502,
      message: "Não consegui falar com a OpenAI. Verifique a internet e tente de novo.",
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      status: 502,
      message: "O login ChatGPT/Codex expirou. Entre de novo nos ajustes de modelos.",
    };
  }
  if (res.status === 400 || res.status === 404 || res.status === 422) {
    return {
      ok: false,
      status: 502,
      message: `A OpenAI não conhece a voz "${voiceId}". Confira o nome da voz.`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: 502,
      message: `A OpenAI respondeu ${res.status} ao gerar o áudio. Tente de novo em instantes.`,
    };
  }
  return {
    ok: true,
    audio: await res.arrayBuffer(),
    mimeType: res.headers.get("content-type")?.split(";")[0] || "audio/mpeg",
  };
}

/**
 * Um WAV de silêncio curtinho para o emulador dos testes: o caminho `POST /tts` inteiro
 * roda — auth, credencial, limites — sem abrir socket para provedor nenhum.
 */
export function scriptedTtsAudio(): { audio: ArrayBuffer; mimeType: string } {
  const sampleRate = 8_000;
  const samples = sampleRate / 10; // 100ms
  const dataBytes = samples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  return { audio: buffer, mimeType: "audio/wav" };
}
