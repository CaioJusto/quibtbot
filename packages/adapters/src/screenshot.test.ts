import { describe, expect, it } from "vitest";
import { screenshotCommand, screenshotPath } from "./screenshot.js";

describe("print da tela", () => {
  it("manda o script embutido, sem depender de pacote na imagem", () => {
    const argv = screenshotCommand("/tmp/foto.png");
    const script = Buffer.from(
      /printf %s "([A-Za-z0-9+/=]+)"/.exec(argv[2] ?? "")?.[1] ?? "",
      "base64",
    ).toString("utf8");
    expect(script).toContain("from Xlib import display");
    expect(script).toContain("IHDR");
    // A conversão é por fatias: pixel a pixel levaria segundos numa tela inteira.
    expect(script).toContain("rgb[0::3] = raw[2::4]");
    expect(argv[2]).not.toContain("imagemagick");
  });

  it("passa o destino como argumento, e não dentro do comando", () => {
    const argv = screenshotCommand("/tmp/foto com espaço.png");
    expect(argv[argv.length - 1]).toBe("/tmp/foto com espaço.png");
    expect(argv[2]).toContain('"$1"');
  });

  it("dá um nome por vez", () => {
    expect(screenshotPath(17)).not.toBe(screenshotPath(18));
  });
});
