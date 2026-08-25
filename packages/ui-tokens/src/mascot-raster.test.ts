import { describe, expect, it } from "vitest";
import {
  mascotAssetName,
  mascotFamilyFor,
  nearestMascotColorKey,
  PICKER_COLOR_SWATCHES,
  PICKER_SHAPES,
} from "./mascot-raster.js";

describe("generated mascot raster map", () => {
  it("exposes only the four silhouettes the picker can actually show", () => {
    expect(PICKER_SHAPES).toEqual(["strobi", "cubee", "nova", "onee"]);
  });

  it("maps stored styles onto blob, cube, drop or orb", () => {
    expect(mascotFamilyFor("strobi")).toBe("blob");
    expect(mascotFamilyFor("kirby")).toBe("blob");
    expect(mascotFamilyFor("cubee")).toBe("cube");
    expect(mascotFamilyFor("freddy")).toBe("cube");
    expect(mascotFamilyFor("grok")).toBe("cube");
    expect(mascotFamilyFor("nova")).toBe("drop");
    expect(mascotFamilyFor("citrus")).toBe("drop");
    expect(mascotFamilyFor("onee")).toBe("orb");
    expect(mascotFamilyFor("circle")).toBe("blob");
  });

  it("picks the nearest generated body color", () => {
    expect(nearestMascotColorKey("#5B7FE5")).toBe("strobi");
    expect(nearestMascotColorKey("#000000")).toBe("grok");
    expect(nearestMascotColorKey("#FFFFFF")).toBe("white");
    expect(nearestMascotColorKey("not-a-color")).toBe("strobi");
  });

  it("names the PNG the same way mobile require() does", () => {
    expect(mascotAssetName("strobi", "#5B7FE5")).toBe("mascot-blob-strobi.png");
    expect(mascotAssetName("cubee", "#E65C5C")).toBe("mascot-cube-cubee.png");
    expect(mascotAssetName("nova", "#55B6C3")).toBe("mascot-drop-nova.png");
    expect(mascotAssetName("onee", "#DBE2F5")).toBe("mascot-orb-onee.png");
    expect(mascotAssetName("citrus", "#FFCF24")).toBe("mascot-drop-citrus.png");
  });

  it("keeps the extra picker dots that reuse a generated body", () => {
    expect(PICKER_COLOR_SWATCHES.map((swatch) => swatch.hex)).toContain("#4ECDC4");
    expect(PICKER_COLOR_SWATCHES.map((swatch) => swatch.hex)).toContain("#B4B7BC");
  });
});
