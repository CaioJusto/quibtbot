import { describe, expect, it } from "vitest";
import { extensionFor, formatDuration, pickMimeType } from "./voice";

describe("recado de voz", () => {
  it("prefere opus, e aceita o que o navegador tiver", () => {
    expect(pickMimeType((type) => type === "audio/webm;codecs=opus")).toBe(
      "audio/webm;codecs=opus",
    );
    expect(pickMimeType((type) => type === "audio/mp4")).toBe("audio/mp4");
    // Nenhum formato aceito: o gravador ainda abre, com o padrão do navegador.
    expect(pickMimeType(() => false)).toBe("");
  });

  it("dá ao arquivo a extensão que combina com o formato gravado", () => {
    expect(extensionFor("audio/webm;codecs=opus")).toBe("webm");
    expect(extensionFor("audio/mp4")).toBe("m4a");
    expect(extensionFor("audio/ogg;codecs=opus")).toBe("ogg");
    expect(extensionFor("")).toBe("webm");
  });

  it("conta o tempo de gravação em minuto e segundo", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(9.7)).toBe("0:09");
    expect(formatDuration(75)).toBe("1:15");
    expect(formatDuration(-3)).toBe("0:00");
  });
});
