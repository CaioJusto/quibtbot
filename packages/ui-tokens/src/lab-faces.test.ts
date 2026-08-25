import { describe, expect, it } from "vitest";
import { MARK_SHAPES } from "./appearance.js";
import {
  LAB_FACES,
  labEyeReadsAsBall,
  labFaceFor,
  labFaceIds,
  labFacesAreUnique,
} from "./lab-faces.js";

describe("lab-faces", () => {
  it("tem uma cara para cada shape do catálogo", () => {
    for (const shape of MARK_SHAPES) {
      expect(LAB_FACES[shape]).toBeDefined();
    }
  });

  it("cada personagem tem uma cara distinta", () => {
    expect(labFacesAreUnique()).toBe(true);
  });

  it("os olhos leem como bola, não como palito esticado", () => {
    for (const id of labFaceIds()) {
      const face = LAB_FACES[id];
      expect(labEyeReadsAsBall(face.eyeScale.left)).toBe(true);
      expect(labEyeReadsAsBall(face.eyeScale.right)).toBe(true);
    }
  });

  it("Grok é bola grande + pontinho, não dois palitos", () => {
    expect(LAB_FACES.grok.eyeScale.left[0]).toBeGreaterThan(LAB_FACES.grok.eyeScale.right[0]);
    expect(LAB_FACES.grok).not.toEqual(LAB_FACES.strobi);
  });

  it("Pip e Loom entram no catálogo com caras próprias", () => {
    expect(MARK_SHAPES).toContain("pip");
    expect(MARK_SHAPES).toContain("loom");
    expect(MARK_SHAPES).toHaveLength(12);
  });

  it("rola a cara em graus, não em radianos", () => {
    for (const id of labFaceIds()) {
      expect(Math.abs(LAB_FACES[id].roll)).toBeLessThanOrEqual(45);
    }
    expect(LAB_FACES.loom.roll).toBeLessThan(-10);
    expect(LAB_FACES.freddy.roll).toBeLessThan(0);
  });

  it("shape desconhecida cai no Strobi", () => {
    expect(labFaceFor("nao-existe")).toEqual(LAB_FACES.strobi);
  });
});
