import { describe, expect, it } from "vitest";
import {
  DEFAULT_TTS_VOICE,
  MAX_TTS_INPUT_CHARS,
  scriptedTtsAudio,
  synthesizeSpeech,
} from "./tts.js";

function fetchStub(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return { impl, calls };
}

describe("synthesizeSpeech", () => {
  it("reuses the ChatGPT/Codex bearer credential and account header", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { impl, calls } = fetchStub(
      () => new Response(bytes, { status: 200, headers: { "content-type": "audio/mpeg" } }),
    );
    const result = await synthesizeSpeech(
      {
        accessToken: "oauth-access",
        accountId: "account-1",
        voiceId: "fable",
        text: "Olá",
      },
      { fetchImpl: impl },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mimeType).toBe("audio/mpeg");
      expect(new Uint8Array(result.audio)).toEqual(bytes);
    }
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/audio/speech");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer oauth-access");
    expect(headers["chatgpt-account-id"]).toBe("account-1");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toMatchObject({ model: "gpt-4o-mini-tts", voice: "fable", input: "Olá" });
  });

  it("uses the default OpenAI voice when none was chosen", async () => {
    const { impl, calls } = fetchStub(() => new Response(new Uint8Array(), { status: 200 }));
    await synthesizeSpeech(
      { accessToken: "oauth-access", voiceId: "  ", text: "Oi" },
      { fetchImpl: impl },
    );
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.voice).toBe(DEFAULT_TTS_VOICE);
  });

  it("cuts text at the character ceiling before sending", async () => {
    const { impl, calls } = fetchStub(() => new Response(new Uint8Array(), { status: 200 }));
    await synthesizeSpeech(
      {
        accessToken: "oauth-access",
        voiceId: "alloy",
        text: "a".repeat(MAX_TTS_INPUT_CHARS + 500),
      },
      { fetchImpl: impl },
    );
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.input).toHaveLength(MAX_TTS_INPUT_CHARS);
  });

  it("rejects empty text and missing OAuth without opening a socket", async () => {
    const { impl, calls } = fetchStub(() => new Response(new Uint8Array(), { status: 200 }));
    const empty = await synthesizeSpeech(
      { accessToken: "oauth-access", voiceId: "", text: "   " },
      { fetchImpl: impl },
    );
    expect(empty).toMatchObject({ ok: false, status: 400 });

    const missingLogin = await synthesizeSpeech(
      { accessToken: "   ", voiceId: "", text: "Oi" },
      { fetchImpl: impl },
    );
    expect(missingLogin).toMatchObject({ ok: false, status: 409 });
    expect(calls).toHaveLength(0);
  });

  it("translates rejected OAuth into a readable reconnect error", async () => {
    const { impl } = fetchStub(() => new Response("{}", { status: 401 }));
    const result = await synthesizeSpeech(
      { accessToken: "expired", voiceId: "", text: "Olá" },
      { fetchImpl: impl },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.message).toContain("ChatGPT/Codex");
    }
  });
});

describe("scriptedTtsAudio", () => {
  it("generates a valid RIFF WAV", () => {
    const { audio, mimeType } = scriptedTtsAudio();
    expect(mimeType).toBe("audio/wav");
    const view = new Uint8Array(audio);
    expect(String.fromCharCode(...view.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...view.subarray(8, 12))).toBe("WAVE");
    expect(audio.byteLength).toBeGreaterThan(44);
  });
});
