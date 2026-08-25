import { describe, expect, it } from "vitest";
import {
  boundedRecordingSeconds,
  DEFAULT_RECORDING_SECONDS,
  FFMPEG_MISSING,
  MAX_RECORDING_SECONDS,
  recordScreenCommand,
} from "./screen-recording.js";

describe("gravar a tela", () => {
  it("mantém a duração dentro do tempo de um comando", () => {
    expect(boundedRecordingSeconds(5)).toBe(5);
    expect(boundedRecordingSeconds(999)).toBe(MAX_RECORDING_SECONDS);
    expect(boundedRecordingSeconds(0)).toBe(DEFAULT_RECORDING_SECONDS);
    expect(boundedRecordingSeconds("dez")).toBe(DEFAULT_RECORDING_SECONDS);
    expect(boundedRecordingSeconds(undefined)).toBe(DEFAULT_RECORDING_SECONDS);
  });

  it("avisa quando a imagem é velha demais, em vez de falhar calado", () => {
    const argv = recordScreenCommand("/tmp/v.mp4", 10);
    expect(argv[2]).toContain("command -v ffmpeg");
    expect(argv[2]).toContain(FFMPEG_MISSING);
  });

  it("passa destino e duração como argumentos, não dentro do comando", () => {
    const argv = recordScreenCommand("/tmp/gravação com espaço.mp4", 7);
    expect(argv.slice(-2)).toEqual(["/tmp/gravação com espaço.mp4", "7"]);
    expect(argv[2]).toContain('"$1"');
    expect(argv[2]).toContain('"$2"');
  });

  it("grava num formato que abre em qualquer lugar", () => {
    const argv = recordScreenCommand("/tmp/v.mp4", 10);
    expect(argv[2]).toContain("libx264");
    expect(argv[2]).toContain("yuv420p");
  });
});
