import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "character-picker.tsx"),
  "utf8",
);
const mark = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "agent-mark.tsx"),
  "utf8",
);
const gallery = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "character-gallery.tsx"),
  "utf8",
);

describe("web character picker matches the mobile generated family", () => {
  it("offers only the four generated silhouettes", () => {
    expect(src).toContain("PICKER_SHAPES.map");
    expect(src).not.toContain("MARK_SHAPES.map");
    expect(src).toContain("Formato");
    expect(src).toContain("PICKER_COLOR_SWATCHES.map");
    expect(src).toContain("MARK_STYLE_LABELS[id]");
    expect(src).toContain("Formato");
    // A silhueta encolheu junto com o seletor, que virou um detalhe da etapa.
    expect(src).toContain("size={40}");
    expect(src.indexOf("PICKER_SHAPES.map")).toBeLessThan(src.indexOf("Cor"));
  });

  it("paints the generated PNG instead of the old CSS face engine", () => {
    expect(mark).toContain("rasterMascotSrc");
    expect(mark).not.toContain("faceEngine");
    expect(mark).not.toContain("MascotAvatar");
    expect(mark).toContain("<img");
  });

  it("shows the four silhouettes on the welcome gallery", () => {
    expect(gallery).toContain("ids = PICKER_SHAPES");
    expect(gallery).not.toContain("ids = MARK_SHAPES");
  });
});
