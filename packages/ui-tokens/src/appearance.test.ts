import { describe, expect, it } from "vitest";
import {
  canonicalizeShape,
  DEFAULT_MARK_COLOR,
  formatAppearance,
  MARK_COLORS,
  MARK_SHAPES,
  markColor,
  markEyeColor,
  markIsLight,
  markShape,
  parseAppearance,
  resolveAppearance,
} from "./appearance.js";

describe("parseAppearance", () => {
  it("reads a colour and lab style out of one stored string", () => {
    expect(parseAppearance("#FF3B30:cubee")).toEqual({
      color: "#FF3B30",
      shape: "cubee",
    });
    expect(parseAppearance("#30D158:cloudee")).toEqual({ color: "#30D158", shape: "cloudee" });
  });

  it("maps legacy geometric ids onto lab styles", () => {
    expect(parseAppearance("#FF3B30:rounded-square")).toEqual({
      color: "#FF3B30",
      shape: "cubee",
    });
    expect(parseAppearance("#30D158:cloud")).toEqual({ color: "#30D158", shape: "cloudee" });
    expect(canonicalizeShape("circle")).toBe("strobi");
    expect(canonicalizeShape("triangle")).toBe("citrus");
  });

  it("treats a bare colour from an older bot as the default style", () => {
    expect(parseAppearance("#E8A54B")).toEqual({ color: "#E8A54B", shape: "strobi" });
  });

  it("falls back when the value is missing or the style is unknown", () => {
    expect(parseAppearance(null)).toEqual({ color: DEFAULT_MARK_COLOR, shape: "strobi" });
    expect(parseAppearance("")).toEqual({ color: DEFAULT_MARK_COLOR, shape: "strobi" });
    expect(parseAppearance("#FF375F:blob")).toEqual({ color: "#FF375F", shape: "strobi" });
    expect(parseAppearance(":nova")).toEqual({ color: DEFAULT_MARK_COLOR, shape: "nova" });
  });

  it("round-trips through the encoded form", () => {
    for (const shape of MARK_SHAPES) {
      for (const { value } of MARK_COLORS) {
        expect(parseAppearance(formatAppearance({ color: value, shape }))).toEqual({
          color: value,
          shape,
        });
      }
    }
  });

  it("exposes the colour and style separately for style props", () => {
    expect(markColor("#BF5AF2:onee")).toBe("#BF5AF2");
    expect(markShape("#BF5AF2:onee")).toBe("onee");
    expect(markColor("#BF5AF2")).toBe("#BF5AF2");
  });
});

describe("resolveAppearance", () => {
  it("lets the encoded colour win over a stale shape column", () => {
    expect(resolveAppearance("#FF453A:onee", "strobi")).toEqual({
      color: "#FF453A",
      shape: "onee",
    });
  });

  it("uses the shape column when colour is still a bare hex", () => {
    expect(resolveAppearance("#FFFFFF", "circle")).toEqual({
      color: "#FFFFFF",
      shape: "strobi",
    });
  });
});

describe("markIsLight", () => {
  it("flags the pale marks that need dark eyes", () => {
    expect(markIsLight("#FFFFFF")).toBe(true);
    expect(markIsLight("#FFD60A")).toBe(true);
    expect(markIsLight("#007AFF")).toBe(false);
    expect(markIsLight("#8E8E93")).toBe(false);
    expect(markIsLight("not-a-hex")).toBe(false);
  });
});

describe("markEyeColor", () => {
  it("paints dark eyes on Pip and Loom so the cara lê no blob claro", () => {
    expect(markEyeColor("#4ECDC4")).toBe("#1A1A1A");
    expect(markEyeColor("#B4B7BC")).toBe("#1A1A1A");
    expect(markEyeColor("#111316")).toBe("#F5F5F7");
  });
});
