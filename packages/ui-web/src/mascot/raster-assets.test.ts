import { describe, expect, it } from "vitest";
import { rasterAssetSrc } from "./raster-assets.js";

describe("rasterAssetSrc", () => {
  it("keeps Vite URL-string imports unchanged", () => {
    expect(rasterAssetSrc("/_astro/mascot.png")).toBe("/_astro/mascot.png");
  });

  it("unwraps Astro ImageMetadata imports", () => {
    expect(rasterAssetSrc({ src: "/_astro/mascot.hash.png" })).toBe("/_astro/mascot.hash.png");
  });
});
