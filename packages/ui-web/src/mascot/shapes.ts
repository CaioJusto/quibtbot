import { canonicalizeShape, MARK_SHAPES, type MarkShape, markEyeColor } from "@quibt/ui-tokens";
import { FACE_BOX, type MascotShape } from "./faceEngine.js";
import { buildLabBody, LAB_STYLES } from "./lab-body.js";

export { MARK_SHAPES };
export type MarkShapeId = MarkShape;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}

function rgbToHex(r: number, g: number, b: number) {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[clamp(r), clamp(g), clamp(b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function mix(hex: string, toward: number, amount: number) {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r + (toward - r) * amount, g + (toward - g) * amount, b + (toward - b) * amount);
}

export function gradientFromColor(color: string): [string, string, string] {
  return [mix(color, 255, 0.28), color, mix(color, 0, 0.32)];
}

export function eyeColorFor(color: string) {
  return markEyeColor(color);
}

export function normalizeShape(value: string | undefined | null): MarkShape {
  return canonicalizeShape(value);
}

/** How much of the mark box the silhouette fills. */
export const BODY_FILL = 1.08;
/** Face (eyes + mouth) relative to the body. */
export const FACE_SCALE = 0.82;

export function toMascotShape(shapeId: string | undefined | null): MascotShape {
  const id = normalizeShape(shapeId);
  const style = LAB_STYLES[id] ?? LAB_STYLES.strobi!;
  const { body, clip } = buildLabBody(style);
  const cx = FACE_BOX / 2;
  const scale = (FACE_BOX / 200) * BODY_FILL * (style.fit ?? 1);
  const fit = `translate(${cx} ${cx}) scale(${scale}) translate(-100 -100)`;
  return {
    name: style.name,
    fit,
    body,
    clip,
    anchor: { x: cx, y: cx - 10, scale: FACE_SCALE },
  };
}
