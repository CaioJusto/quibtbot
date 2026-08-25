import type { ComponentType } from "react";
import type { ViewProps, ViewStyle } from "react-native";

export type LiquidGlassStyle = "clear" | "regular" | "none";

export type LiquidGlassViewProps = ViewProps & {
  glassEffectStyle?: LiquidGlassStyle;
  tintColor?: string;
  isInteractive?: boolean;
  colorScheme?: "auto" | "light" | "dark";
  style?: ViewStyle | ViewStyle[];
};

let cached: ComponentType<LiquidGlassViewProps> | null | undefined;

/**
 * O `GlassView` do iOS 26 — o Liquid Glass de verdade, com refração e a reação ao
 * conteúdo que passa por baixo. `expo-glass-effect` roda no Expo Go, mas devolve
 * `false` em `isLiquidGlassAvailable()` num iPhone anterior ao iOS 26, e o import
 * estoura no Android e na web. O `require` em try/catch cobre os dois casos: quem
 * chama cai no blur sempre que vier `null`.
 */
export function liquidGlassView(): ComponentType<LiquidGlassViewProps> | null {
  if (cached !== undefined) return cached;
  try {
    const mod = require("expo-glass-effect") as {
      GlassView: ComponentType<LiquidGlassViewProps>;
      isLiquidGlassAvailable: () => boolean;
    };
    cached = mod.isLiquidGlassAvailable() ? mod.GlassView : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** True quando o app roda como build nativo com o SDK do iOS 26. */
export function hasLiquidGlass(): boolean {
  return liquidGlassView() !== null;
}
