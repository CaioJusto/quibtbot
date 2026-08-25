import { describe, expect, it } from "vitest";
import { fileViewerKind } from "./file-kind.js";

describe("fileViewerKind (o que abre dentro do app)", () => {
  it("decide pelo MIME primeiro", () => {
    expect(fileViewerKind("image/png")).toBe("image");
    expect(fileViewerKind("video/mp4")).toBe("video");
    expect(fileViewerKind("audio/mpeg")).toBe("audio");
    expect(fileViewerKind("text/plain")).toBe("text");
    expect(fileViewerKind("application/json")).toBe("text");
    expect(fileViewerKind("application/pdf")).toBe("other");
  });

  it("desempata pelo nome quando o MIME vem genérico", () => {
    expect(fileViewerKind("application/octet-stream", "notas.md")).toBe("text");
    expect(fileViewerKind("application/octet-stream", "video.mp4")).toBe("video");
    expect(fileViewerKind(undefined, "foto.HEIC")).toBe("image");
    expect(fileViewerKind("", "dados.csv?x=1")).toBe("text");
    expect(fileViewerKind("application/octet-stream", "binario.bin")).toBe("other");
    expect(fileViewerKind(undefined, undefined)).toBe("other");
  });
});
