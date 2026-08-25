/**
 * A bot's character mark — colour plus style — encoded into the single `Bot.color`
 * string the API already stores, as `#RRGGBB:style` (e.g. `#5B7FE5:strobi`).
 * Older rows hold a bare colour or a legacy geometric id (`circle`, `triangle`, …);
 * parsing always canonicalises those onto the Avatar Lab styles.
 */

export const MARK_SHAPES = [
  "strobi",
  "freddy",
  "citrus",
  "nova",
  "grok",
  "sunee",
  "kirby",
  "cloudee",
  "cubee",
  "onee",
  "pip",
  "loom",
] as const;
export type MarkShape = (typeof MARK_SHAPES)[number];

export const MARK_STYLE_LABELS: Record<MarkShape, string> = {
  strobi: "Strobi",
  freddy: "Freddy",
  citrus: "Citrus",
  nova: "Nova",
  grok: "Grok",
  sunee: "Sunee",
  kirby: "Kirby",
  cloudee: "Cloudee",
  cubee: "Cubee",
  onee: "Onee",
  pip: "Pip",
  loom: "Loom",
};

export const MARK_STYLE_COLORS: Record<MarkShape, string> = {
  strobi: "#5B7FE5",
  freddy: "#E6855C",
  citrus: "#FFCF24",
  nova: "#55B6C3",
  grok: "#000000",
  sunee: "#E69A5C",
  kirby: "#FFC2E9",
  cloudee: "#C9CBCF",
  cubee: "#E65C5C",
  onee: "#DBE2F5",
  pip: "#4ECDC4",
  loom: "#B4B7BC",
};

/** Older geometric ids written before the Lab styles. */
const LEGACY_SHAPES: Record<string, MarkShape> = {
  circle: "strobi",
  oval: "nova",
  "rounded-square": "cubee",
  pill: "nova",
  triangle: "citrus",
  hexagon: "onee",
  cloud: "cloudee",
  teardrop: "onee",
  cone: "citrus",
};

export const MARK_COLORS = [
  { name: "White", value: "#FFFFFF" },
  { name: "Navy", value: "#0B3A78" },
  { name: "Strobi", value: "#5B7FE5" },
  { name: "Freddy", value: "#E6855C" },
  { name: "Citrus", value: "#FFCF24" },
  { name: "Nova", value: "#55B6C3" },
  { name: "Grok", value: "#000000" },
  { name: "Sunee", value: "#E69A5C" },
  { name: "Kirby", value: "#FFC2E9" },
  { name: "Cloudee", value: "#C9CBCF" },
  { name: "Cubee", value: "#E65C5C" },
  { name: "Onee", value: "#DBE2F5" },
  { name: "Pip", value: "#4ECDC4" },
  { name: "Loom", value: "#B4B7BC" },
] as const;

export const DEFAULT_MARK_COLOR = MARK_STYLE_COLORS.strobi;
export const DEFAULT_MARK_SHAPE: MarkShape = "strobi";

export type Appearance = { color: string; shape: MarkShape };

export const DEFAULT_APPEARANCE: Appearance = {
  color: DEFAULT_MARK_COLOR,
  shape: DEFAULT_MARK_SHAPE,
};

export function canonicalizeShape(value: string | null | undefined): MarkShape {
  if (!value) return DEFAULT_MARK_SHAPE;
  if ((MARK_SHAPES as readonly string[]).includes(value)) return value as MarkShape;
  return LEGACY_SHAPES[value] ?? DEFAULT_MARK_SHAPE;
}

/** Split a stored `Bot.color` into a CSS colour and a mark style. */
export function parseAppearance(raw: string | null | undefined): Appearance {
  if (!raw) return { ...DEFAULT_APPEARANCE };
  const separator = raw.indexOf(":");
  if (separator === -1) {
    const color = raw.trim();
    return { color: color || DEFAULT_MARK_COLOR, shape: DEFAULT_MARK_SHAPE };
  }
  const color = raw.slice(0, separator).trim();
  const shape = raw.slice(separator + 1).trim();
  return {
    color: color || DEFAULT_MARK_COLOR,
    shape: canonicalizeShape(shape),
  };
}

/**
 * Resolve a mark from the encoded `color` column and the optional `shape`
 * column. Encoded `#RRGGBB:style` wins so a stale shape field cannot override
 * a picker save; bare colours still honour the separate shape column.
 */
export function resolveAppearance(color?: string | null, shape?: string | null): Appearance {
  const parsed = parseAppearance(color);
  if (color?.includes(":")) return parsed;
  return {
    color: parsed.color,
    shape: canonicalizeShape(shape || parsed.shape),
  };
}

/** Encode an appearance back into the `Bot.color` string. */
export function formatAppearance(appearance: Appearance): string {
  const color = appearance.color.trim() || DEFAULT_MARK_COLOR;
  const shape = canonicalizeShape(appearance.shape);
  return `${color}:${shape}`;
}

/** The CSS colour inside a stored `Bot.color` — safe to hand to a style prop. */
export function markColor(raw: string | null | undefined): string {
  return parseAppearance(raw).color;
}

export function markShape(raw: string | null | undefined): MarkShape {
  return parseAppearance(raw).shape;
}

function parseHexRgb(color: string): [number, number, number] | null {
  const hex = color.trim().replace("#", "");
  if (hex.length !== 6) return null;
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  if (Number.isNaN(r + g + b)) return null;
  return [r, g, b];
}

/** Marks in the light half of the palette need dark eyes to stay legible. */
export function markIsLight(color: string): boolean {
  const rgb = parseHexRgb(color);
  if (!rgb) return false;
  const [r, g, b] = rgb;
  return (r * 299 + g * 587 + b * 114) / 1000 > 186;
}

/** Eye fill that stays readable on the mark colour — same rule on web and mobile. */
export function markEyeColor(color: string): string {
  const rgb = parseHexRgb(color);
  if (!rgb) return "#111";
  const [r, g, b] = rgb;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.62 ? "#1A1A1A" : "#F5F5F7";
}
