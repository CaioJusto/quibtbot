import { describe, expect, it } from "vitest";
import { cleanTranscript, resample, WHISPER_SAMPLE_RATE } from "./transcribe";

describe("transcrição local", () => {
  it("reamostra para os 16 kHz que o modelo espera", () => {
    const input = new Float32Array([0, 1, 0, -1, 0, 1, 0, -1]);
    const out = resample(input, 32_000, WHISPER_SAMPLE_RATE);
    expect(out).toHaveLength(4);
    // Mesma taxa não mexe no áudio.
    expect(resample(input, 16_000, 16_000)).toBe(input);
    expect(resample(new Float32Array(), 44_100, 16_000)).toHaveLength(0);
  });

  it("interpola em vez de descartar amostras", () => {
    const out = resample(new Float32Array([0, 1]), 16_000, 32_000);
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(0.5);
  });

  it("tira as marcações que o modelo escreve quando não há fala", () => {
    expect(cleanTranscript("  [MÚSICA]  bom   dia ")).toBe("bom dia");
    expect(cleanTranscript("(risos) tudo certo")).toBe("tudo certo");
    expect(cleanTranscript("[silêncio]")).toBe("");
  });
});
