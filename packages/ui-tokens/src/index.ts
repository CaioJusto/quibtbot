/**
 * A paleta do Quibt, igual à de `tokens.css`. Os mesmos valores em objeto, para quem
 * não escreve CSS — hoje o app Expo. Ver docs/design-system.md.
 */
export const tokens = {
  /** Sob tudo: conversa, painéis, modais. Não é branco puro. */
  page: "#FCFCFC",
  /** A lista de bots e outras faixas laterais. */
  sidebar: "#F7F7F7",
  /** Bolha do bot, cartões agrupados. */
  surface: "#EEEEEE",
  /** Linha selecionada, botão sutil, busca do modal. */
  surface2: "#F0F0F0",
  /** Campo embutido, como a busca da lista. */
  inset: "#EBEBEB",
  /** Quadrado de ícone. */
  tile: "#E5E5E5",
  hairline: "#E0E0E0",
  hairlineSoft: "#E0E0E0",
  /** Texto: principal, forte, secundário, terciário. Cinzas neutros. */
  ink: "#141414",
  inkStrong: "#070707",
  muted: "#707070",
  muted2: "#9E9E9E",
  blue: "#3C82F6",
  green: "#34C759",
  red: "#EB4145",
  orange: "#FF9F0A",
  yellow: "#FFD60A",
  accent: "#3C82F6",
  danger: "#EB4145",
  dangerSoft: "#EDE3E4",
  success: "#34C759",
  scrim: "rgba(0, 0, 0, 0.46)",
  radius: 10,
} as const;

/** Cinco degraus de curvatura: badge, botão, cartão, bolha, modal. */
export const radii = { xs: 6, sm: 8, md: 10, lg: 14, xl: 20 } as const;

/** Cinco tamanhos de letra. */
export const textSizes = { xs: 12, sm: 13, md: 14, lg: 15, title: 22 } as const;

export const fonts = {
  /** San Francisco on Apple platforms, the platform UI font elsewhere. */
  sans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
} as const;

export {
  type Appearance,
  canonicalizeShape,
  DEFAULT_APPEARANCE,
  DEFAULT_MARK_COLOR,
  DEFAULT_MARK_SHAPE,
  formatAppearance,
  MARK_COLORS,
  MARK_SHAPES,
  MARK_STYLE_COLORS,
  MARK_STYLE_LABELS,
  type MarkShape,
  markColor,
  markEyeColor,
  markIsLight,
  markShape,
  parseAppearance,
  resolveAppearance,
} from "./appearance.js";
export { type AgentBurst, type BurstMessage, multiAgentBursts } from "./bursts.js";
export {
  LAB_FACES,
  type LabEyeScale,
  type LabFaceId,
  type LabFaceRecipe,
  labEyeReadsAsBall,
  labFaceFor,
  labFaceIds,
  labFacesAreUnique,
} from "./lab-faces.js";
export {
  MASCOT_COLOR_SWATCHES,
  type MascotColorKey,
  type MascotFamily,
  mascotAssetName,
  mascotFamilyFor,
  nearestMascotColorKey,
  PICKER_COLOR_SWATCHES,
  PICKER_SHAPES,
  type PickerShape,
} from "./mascot-raster.js";

/** Fallback palette for bots created without a chosen mark colour. */
export const botColors = [
  "#007AFF",
  "#FF9F0A",
  "#30D158",
  "#BF5AF2",
  "#40C8E0",
  "#FF453A",
  "#FF375F",
] as const;
