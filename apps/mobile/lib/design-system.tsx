import { radii, textSizes, tokens } from "@quibt/ui-tokens";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  DynamicColorIOS,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentMark, GroupMark } from "./agent-mark";
import { liquidGlassView } from "./liquid-glass";
import { AppSymbol, type AppSymbolName } from "./native";

export type { NativeMenuAction } from "./native-glass-menu";
export { NativeGlassMenu } from "./native-glass-menu";

/**
 * A paleta do produto, vinda de `@quibt/ui-tokens` — os mesmos valores do web e do
 * desktop. O sistema é claro: nada de superfície escura fora da prévia da tela do bot.
 * Ver docs/design-system.md.
 */
/**
 * Cada cor do app com as duas versões: no iOS o `DynamicColorIOS` entrega a certa
 * conforme o modo (claro/escuro/sistema — ver lib/appearance.ts), inclusive dentro de
 * `StyleSheet.create` de módulo. Fora do iOS fica a clara, que é a paleta do produto.
 * Mascotes e verdes de status são conteúdo e não passam por aqui.
 */
function dyn(light: string, dark: string): string {
  if (Platform.OS !== "ios") return light;
  return DynamicColorIOS({ light, dark }) as unknown as string;
}

export const COLORS = {
  // O escuro é um carvão, não um preto: fundo #161618 com camadas subindo de leve,
  // como nos apps de chat escuros — preto puro engolia cartões, bolhas e divisores.
  background: dyn(tokens.page, "#161618"),
  rail: dyn(tokens.sidebar, "#1A1A1D"),
  /** Só a prévia da tela do bot, que é a máquina de verdade e não cromo do app. */
  black: "#000000",
  card: dyn(tokens.surface2, "#232327"),
  /** A bolha do bot na conversa. */
  bubble: dyn(tokens.surface, "#212125"),
  cardRaised: dyn(tokens.inset, "#2A2A2F"),
  tile: dyn(tokens.tile, "#313137"),
  separator: dyn(tokens.hairline, "#35353C"),
  primary: dyn(tokens.ink, "#F2F2F4"),
  primaryStrong: dyn(tokens.inkStrong, "#FFFFFF"),
  secondary: dyn(tokens.muted, "#A6A6AE"),
  tertiary: dyn(tokens.muted2, "#787881"),
  /** A bolha da pessoa: tinta no claro, cinza elevado no escuro — nunca um cartão branco. */
  mineBubble: dyn(tokens.inkStrong, "#333338"),
  mineInk: dyn(tokens.page, "#F5F5F7"),
  blue: tokens.accent,
  green: tokens.green,
  red: dyn(tokens.danger, "#FF5A5E"),
  redSoft: dyn(tokens.dangerSoft, "#3A2426"),
  orange: tokens.orange,
  scrim: dyn(tokens.scrim, "rgba(0, 0, 0, 0.6)"),
  glassBorder: dyn("rgba(20, 20, 20, 0.08)", "rgba(255, 255, 255, 0.12)"),
} as const;

export const METRICS = {
  pageInset: 20,
  topControl: 44,
  cardRadius: radii.md,
  rowHeight: 72,
} as const;

export const RADII = radii;
export const TEXT_SIZES = textSizes;

export function softHaptic() {
  if (Platform.OS === "ios") {
    void Haptics.selectionAsync();
  }
}

/**
 * Vidro do sistema quando o aparelho tem iOS 26 — o `GlassView` refrata o que passa
 * por baixo e reage ao toque, coisa que o blur não faz. Fora daí, o mesmo desenho
 * em `expo-blur`: mesma borda, mesmo raio, mesma opacidade de leite.
 */
export function GlassSurface({
  children,
  style,
  interactive = false,
  clear = false,
}: {
  children?: ReactNode;
  style?: ViewStyle | ViewStyle[];
  interactive?: boolean;
  clear?: boolean;
}) {
  const flattened = StyleSheet.flatten(style);
  // O vidro é do tema: um borrão claro sobre fundo escuro vira uma mancha branca.
  const tint = useColorScheme() === "dark" ? ("dark" as const) : ("light" as const);
  const Glass = liquidGlassView();
  if (Glass) {
    return (
      <Glass
        glassEffectStyle="regular"
        isInteractive={interactive}
        colorScheme={tint}
        style={[styles.glassNative, flattened]}
      >
        {children}
      </Glass>
    );
  }
  // A sombra mora no invólucro: `overflow: hidden` no próprio blur a recortaria fora.
  return (
    <View
      style={[
        styles.glassShadow,
        flattened && {
          width: flattened.width,
          height: flattened.height,
          borderRadius: flattened.borderRadius,
          flex: flattened.flex,
        },
      ]}
    >
      <BlurView
        intensity={clear ? 26 : 40}
        tint={tint}
        style={[styles.glassBase, flattened, interactive && styles.glassInteractive]}
      >
        {children}
      </BlurView>
    </View>
  );
}

export function GlassIconButton({
  symbol,
  label,
  onPress,
  size = METRICS.topControl,
  symbolSize = 21,
}: {
  symbol: AppSymbolName;
  label: string;
  onPress: () => void;
  size?: number;
  symbolSize?: number;
}) {
  return (
    <GlassSurface interactive clear style={{ width: size, height: size, borderRadius: size / 2 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={() => {
          softHaptic();
          onPress();
        }}
        style={styles.centerFill}
      >
        <AppSymbol name={symbol} size={symbolSize} color={COLORS.primary} />
      </Pressable>
    </GlassSurface>
  );
}

/** Ação principal de uma tela: pílula de tinta forte, igual à `.qb-primary-button` do web. */
export function PrimaryButton({
  label,
  onPress,
  disabled,
  pending,
  style,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  pending?: boolean;
  style?: ViewStyle;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled || pending) }}
      disabled={disabled || pending}
      onPress={() => {
        softHaptic();
        onPress();
      }}
      style={({ pressed }) => [
        styles.primaryButton,
        style,
        (disabled || pending) && { opacity: 0.45 },
        pressed && styles.buttonPressed,
      ]}
    >
      {pending ? (
        <ActivityIndicator color={COLORS.background} />
      ) : (
        <Text style={styles.primaryButtonText}>{label}</Text>
      )}
    </Pressable>
  );
}

/** Ação de apoio: mesma pílula, sobre a página, com o fio do sistema. */
export function SecondaryButton({
  label,
  onPress,
  disabled,
  destructive,
  style,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
  style?: ViewStyle;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={() => {
        softHaptic();
        onPress();
      }}
      style={({ pressed }) => [
        styles.secondaryButton,
        style,
        disabled && { opacity: 0.45 },
        pressed && styles.buttonPressed,
      ]}
    >
      <Text style={[styles.secondaryButtonText, destructive && { color: COLORS.red }]}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Quanto o conteúdo de uma tela precisa descer para não ficar atrás do ScreenHeader,
 * que flutua sobre a página: a área segura do topo, a folga do cabeçalho e o botão.
 * Um número fixo (88) passava no simulador sem ilha e cortava o título no iPhone.
 */
export function useHeaderContentInset(extra = 16, modal = false): number {
  const insets = useSafeAreaInsets();
  return headerTopOffset(insets.top, modal) + METRICS.topControl + extra;
}

/**
 * Onde o cabeçalho flutuante começa. Numa folha modal do iOS a área segura de cima ainda
 * vem cheia, mas a folha já está abaixo da barra de status: usar o recuo inteiro deixava
 * um buraco de meia tela acima do botão de voltar.
 */
export function headerTopOffset(safeTop: number, modal = false): number {
  return modal ? 14 : Math.max(safeTop, 12) + 8;
}

export function ScreenHeader({
  onBack,
  title,
  color,
  shape,
  members,
  right,
  onTitlePress,
  modal,
}: {
  onBack: () => void;
  title?: string;
  color?: string;
  shape?: string;
  members?: Array<{ id: string; name: string; color: string; shape?: string }>;
  right?: ReactNode;
  onTitlePress?: () => void;
  /** Numa folha modal o cabeçalho encosta no topo da folha, não na barra de status. */
  modal?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.header, { paddingTop: headerTopOffset(insets.top, modal) }]}>
      <GlassIconButton symbol="chevron.left" label="Voltar" onPress={onBack} />
      {title ? (
        <GlassSurface clear style={styles.headerPill}>
          <Pressable
            disabled={!onTitlePress}
            onPress={() => {
              if (onTitlePress) {
                softHaptic();
                onTitlePress();
              }
            }}
            style={styles.headerPillContent}
          >
            {members ? (
              <GroupMark members={members} size={30} />
            ) : color ? (
              <AgentMark color={color} shape={shape} size={30} />
            ) : null}
            <Text numberOfLines={1} style={styles.headerTitle}>
              {title}
            </Text>
          </Pressable>
        </GlassSurface>
      ) : (
        <View style={{ flex: 1 }} />
      )}
      <View style={{ width: METRICS.topControl, alignItems: "flex-end" }}>{right}</View>
    </View>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

export function SectionCard({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Separator({ inset = 0 }: { inset?: number }) {
  return (
    <View
      style={{
        height: StyleSheet.hairlineWidth,
        backgroundColor: COLORS.separator,
        marginLeft: inset,
      }}
    />
  );
}

export const textStyles = StyleSheet.create({
  title: {
    color: COLORS.primary,
    fontSize: textSizes.title,
    lineHeight: 27,
    fontWeight: "600",
    letterSpacing: -0.4,
  },
  body: { color: COLORS.primary, fontSize: 17, lineHeight: 23 },
  secondary: { color: COLORS.secondary, fontSize: textSizes.lg, lineHeight: 21 },
  rowTitle: { color: COLORS.primary, fontSize: 17, lineHeight: 22, fontWeight: "600" },
});

const styles = StyleSheet.create({
  /**
   * O fundo é quase branco e a página também — sem a sombra o controle sumia e
   * sobrava o ícone solto no meio do nada. É a sombra que separa o vidro do papel,
   * do mesmo jeito que nos controles do sistema.
   */
  glassBase: {
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.glassBorder,
    backgroundColor: "rgba(255, 255, 255, 0.92)",
  },
  glassInteractive: { backgroundColor: "rgba(255, 255, 255, 0.96)" },
  glassShadow: {
    shadowColor: "#0B0B0B",
    shadowOpacity: 0.1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  /**
   * O vidro do sistema traz a própria borda e o próprio fundo — forçar os nossos o
   * deixa opaco. A sombra é o que separa o controle do papel branco: sem ela o
   * vidro sobre fundo claro some, e sobra o ícone solto no meio do nada.
   */
  glassNative: {
    shadowColor: "#0B0B0B",
    shadowOpacity: 0.1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  centerFill: { flex: 1, alignItems: "center", justifyContent: "center" },
  primaryButton: {
    minHeight: 50,
    borderRadius: 999,
    paddingHorizontal: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.primaryStrong,
  },
  primaryButtonText: {
    color: COLORS.background,
    fontSize: 17,
    fontWeight: "600",
  },
  secondaryButton: {
    minHeight: 50,
    borderRadius: 999,
    paddingHorizontal: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.separator,
  },
  secondaryButtonText: { color: COLORS.primary, fontSize: 17, fontWeight: "600" },
  buttonPressed: { opacity: 0.72, transform: [{ scale: 0.985 }] },
  header: {
    position: "absolute",
    zIndex: 20,
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    pointerEvents: "box-none",
  },
  headerPill: {
    minHeight: METRICS.topControl,
    maxWidth: 250,
    flex: 1,
    borderRadius: 22,
  },
  headerPillContent: {
    flex: 1,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  headerTitle: { color: COLORS.primary, fontSize: 17, fontWeight: "600", flexShrink: 1 },
  sectionLabel: {
    color: COLORS.tertiary,
    fontSize: textSizes.xs,
    lineHeight: 16,
    fontWeight: "700",
    letterSpacing: 0.06,
    textTransform: "uppercase",
    marginLeft: 16,
    marginBottom: 8,
    marginTop: 26,
  },
  card: {
    backgroundColor: COLORS.card,
    borderRadius: METRICS.cardRadius,
    overflow: "hidden",
  },
});
