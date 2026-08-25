import { describe, expect, it } from "vitest";
import { FACE_BOX } from "./faceEngine.js";
import { MARK_SHAPES, normalizeShape, toMascotShape } from "./shapes.js";

describe("toMascotShape", () => {
  it("maps every lab style onto a silhouette with a gradient token", () => {
    for (const id of MARK_SHAPES) {
      const shape = toMascotShape(id);
      expect(shape.body).toContain("{{GRADIENT}}");
      expect(shape.clip.length).toBeGreaterThan(8);
      expect(shape.fit).toContain("scale(");
    }
  });

  it("canonicalises legacy geometric ids onto lab styles", () => {
    expect(normalizeShape("nope")).toBe("strobi");
    expect(normalizeShape("circle")).toBe("strobi");
    expect(normalizeShape("triangle")).toBe("citrus");
    expect(normalizeShape("cloud")).toBe("cloudee");
  });

  it("fills the mark box so the body reads as large as the Avatar Lab preview", () => {
    const strobi = toMascotShape("strobi");
    const strobiScale = Number(/scale\(([0-9.]+)\)/.exec(strobi.fit)?.[1]);
    expect(strobiScale).toBeCloseTo((FACE_BOX / 200) * 1.08, 5);
    expect(strobi.anchor.scale).toBeCloseTo(0.82, 5);
  });

  it("scales accessory styles down so ears and rays stay in the mark box", () => {
    const strobi = toMascotShape("strobi");
    const freddy = toMascotShape("freddy");
    const strobiScale = Number(/scale\(([0-9.]+)\)/.exec(strobi.fit)?.[1]);
    const freddyScale = Number(/scale\(([0-9.]+)\)/.exec(freddy.fit)?.[1]);
    expect(freddyScale).toBeLessThan(strobiScale);
  });

  it("gives accessory lab styles a distinct silhouette from the sphere", () => {
    const strobi = toMascotShape("strobi").body;
    expect(toMascotShape("grok").body).toBe(strobi);
    expect(toMascotShape("pip").body).not.toBe(strobi);
    expect(toMascotShape("loom").body).not.toBe(strobi);
    expect(toMascotShape("citrus").body).not.toBe(strobi);
    expect(toMascotShape("onee").body).not.toBe(toMascotShape("citrus").body);
    expect(toMascotShape("freddy").body).not.toBe(strobi);
    expect(toMascotShape("sunee").clip.length).toBeGreaterThan(toMascotShape("strobi").clip.length);
  });
});
