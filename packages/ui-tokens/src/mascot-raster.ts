import { canonicalizeShape } from "./appearance.js";

/** The four generated silhouettes. Other stored styles map onto these families. */
export const PICKER_SHAPES = ["strobi", "cubee", "nova", "onee"] as const;

export type PickerShape = (typeof PICKER_SHAPES)[number];

export type MascotFamily = "blob" | "cube" | "drop" | "orb";

export type MascotColorKey =
  | "white"
  | "navy"
  | "strobi"
  | "freddy"
  | "citrus"
  | "nova"
  | "grok"
  | "sunee"
  | "kirby"
  | "cloudee"
  | "cubee"
  | "onee";

export const MASCOT_COLOR_SWATCHES = [
  { key: "white" as const, hex: "#FFFFFF", name: "Branco" },
  { key: "navy" as const, hex: "#0B3A78", name: "Azul marinho" },
  { key: "strobi" as const, hex: "#5B7FE5", name: "Azul Quibt" },
  { key: "freddy" as const, hex: "#E6855C", name: "Coral" },
  { key: "citrus" as const, hex: "#FFCF24", name: "Amarelo" },
  { key: "nova" as const, hex: "#55B6C3", name: "Turquesa" },
  { key: "grok" as const, hex: "#111316", name: "Preto" },
  { key: "sunee" as const, hex: "#E69A5C", name: "Laranja" },
  { key: "kirby" as const, hex: "#FFC2E9", name: "Rosa" },
  { key: "cloudee" as const, hex: "#C9CBCF", name: "Cinza" },
  { key: "cubee" as const, hex: "#E65C5C", name: "Vermelho" },
  { key: "onee" as const, hex: "#DBE2F5", name: "Azul gelo" },
] as const;

/** Extra picker dots that reuse the nearest generated body color. */
export const PICKER_COLOR_SWATCHES = [
  ...MASCOT_COLOR_SWATCHES,
  { key: "pip" as const, hex: "#4ECDC4", name: "Verde água" },
  { key: "loom" as const, hex: "#B4B7BC", name: "Prata" },
] as const;

export function mascotFamilyFor(shape: string | null | undefined): MascotFamily {
  const id = canonicalizeShape(shape);
  if (id === "onee") return "orb";
  if (id === "grok" || id === "cubee" || id === "freddy") return "cube";
  if (id === "nova" || id === "citrus") return "drop";
  return "blob";
}

export function parseHexRgb(color: string): { r: number; g: number; b: number } | null {
  const hex = color.trim().replace("#", "").slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

export function nearestMascotColorKey(color: string): MascotColorKey {
  const wanted = parseHexRgb(color);
  if (!wanted) return "strobi";
  let best: MascotColorKey = "strobi";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of MASCOT_COLOR_SWATCHES) {
    const rgb = parseHexRgb(candidate.hex);
    if (!rgb) continue;
    const distance = (wanted.r - rgb.r) ** 2 + (wanted.g - rgb.g) ** 2 + (wanted.b - rgb.b) ** 2;
    if (distance < bestDistance) {
      best = candidate.key;
      bestDistance = distance;
    }
  }
  return best;
}

export function mascotAssetName(shape: string | null | undefined, color: string): string {
  return `mascot-${mascotFamilyFor(shape)}-${nearestMascotColorKey(color)}.png`;
}
