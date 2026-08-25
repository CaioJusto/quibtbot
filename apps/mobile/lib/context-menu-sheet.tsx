import { tokens } from "@quibt/ui-tokens";
import { BlurView } from "expo-blur";
import { SymbolView } from "expo-symbols";
import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  DynamicColorIOS,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
  type ViewStyle,
} from "react-native";

/** As duas versões de cada cor deste menu; no iOS o sistema entrega a do modo em vigor. */
function dynColor(light: string, dark: string): string {
  if (Platform.OS !== "ios") return light;
  return DynamicColorIOS({ light, dark }) as unknown as string;
}

export type ContextMenuAnchor = { x: number; y: number; width: number; height: number };

export type ContextMenuEntry = {
  label: string;
  systemImage: string;
  onPress?: () => void;
  destructive?: boolean;
  /**
   * Um segundo nível, como o "More" do menu do sistema: o cartão de cima esmaece e as
   * ações raras aparecem embaixo. Serve para tirar da frente o que quase nunca se usa
   * sem escondê-lo de quem procura.
   */
  submenu?: ContextMenuEntry[];
};

/** Largo o bastante para "Fixar como favorito" caber sem reticências. */
const CARD_WIDTH = 300;
const ITEM_HEIGHT = 56;
const GAP = 10;

/**
 * O `UIContextMenu` do iOS reproduzido em JS: o fundo desfoca, a linha tocada fica
 * flutuando no lugar onde estava e o menu abre colado nela. O menu do sistema só
 * existe via `@expo/ui`, que exige build nativo — no Expo Go este é o desenho que
 * chega mais perto, em vez do action sheet empilhado.
 */
export function ContextMenuSheet({
  visible,
  anchor,
  entries,
  onClose,
  rowStyle,
  children,
  highlight,
  alignRight = false,
  accessory,
}: {
  visible: boolean;
  anchor: ContextMenuAnchor | null;
  entries: ContextMenuEntry[];
  onClose: () => void;
  /** O layout da própria linha; sem ele o conteúdo destacado empilha em coluna. */
  rowStyle?: ViewStyle | ViewStyle[];
  /** Sem filhos o menu abre ancorado ao ponto, sem cópia flutuante — o caso de um botão. */
  children?: React.ReactNode;
  /**
   * O que aparece no cartão que sobe. Quando vem, substitui a linha: no menu do
   * sistema o destaque é um resumo — marca, nome e hora —, não a linha inteira com a
   * prévia da conversa, que ali só faz o cartão crescer sem dizer mais nada.
   */
  highlight?: React.ReactNode;
  /** Ancorar pelo lado direito, para menus que abrem a partir de botões da borda direita. */
  alignRight?: boolean;
  /**
   * Uma fileira flutuante logo acima do cartão — as reações rápidas de uma mensagem,
   * como nos apps de chat: emojis primeiro, ações embaixo.
   */
  accessory?: React.ReactNode;
}) {
  const enter = useRef(new Animated.Value(0)).current;
  const [expanded, setExpanded] = useState<string | null>(null);
  const tint = useColorScheme() === "dark" ? ("dark" as const) : ("light" as const);

  useEffect(() => {
    if (!visible) {
      enter.setValue(0);
      setExpanded(null);
      return;
    }
    Animated.spring(enter, {
      toValue: 1,
      useNativeDriver: true,
      speed: 18,
      bounciness: 6,
    }).start();
  }, [enter, visible]);

  if (!anchor) return null;

  const screen = Dimensions.get("window");
  const accessoryHeight = accessory ? 56 + GAP : 0;
  const menuHeight = entries.length * ITEM_HEIGHT + 16 + accessoryHeight;
  // Abaixo da linha quando cabe; acima quando a linha está no pé da tela.
  const below = anchor.y + anchor.height + GAP + menuHeight < screen.height - 24;
  const menuTop = below ? anchor.y + anchor.height + GAP : anchor.y - GAP - menuHeight;
  // O cartão do menu nasce centrado no item destacado (um favorito pequeno, uma linha
  // larga), e só encosta na borda quando não cabe — antes ele grudava à esquerda da linha
  // e ficava torto em relação ao destaque.
  const wantedLeft = alignRight
    ? anchor.x + anchor.width - CARD_WIDTH
    : anchor.x + anchor.width / 2 - CARD_WIDTH / 2;
  const menuLeft = Math.min(Math.max(wantedLeft, 12), screen.width - CARD_WIDTH - 12);

  const expandedEntries = entries.find((entry) => entry.label === expanded)?.submenu ?? [];
  const scale = enter.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] });

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <BlurView intensity={22} tint={tint} style={StyleSheet.absoluteFill}>
        <Pressable
          accessibilityLabel="Fechar menu"
          accessibilityRole="button"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />

        {/* A própria linha, congelada na posição em que o dedo a encontrou. */}
        {children || highlight ? (
          <View
            pointerEvents="none"
            style={[
              styles.highlight,
              {
                top: anchor.y - 6,
                left: Math.max(anchor.x - 6, 6),
                width: anchor.width + 12,
                minHeight: anchor.height + 12,
                // Um favorito (só a marca) fica no centro do cartão; uma linha ocupa tudo.
                alignItems: highlight ? "stretch" : "center",
              },
            ]}
          >
            {highlight ?? <View style={[rowStyle, styles.highlightRow]}>{children}</View>}
          </View>
        ) : null}

        <Animated.View
          style={[
            styles.card,
            {
              top: menuTop,
              left: menuLeft,
              opacity: enter,
              transform: [{ scale }],
            },
          ]}
        >
          {accessory ? <View style={styles.accessory}>{accessory}</View> : null}
          <BlurView
            intensity={64}
            tint={tint}
            style={[styles.cardBlur, expanded ? styles.cardDimmed : null]}
          >
            {entries.map((entry) => (
              <Pressable
                accessibilityRole="button"
                key={entry.label}
                onPress={() => {
                  if (entry.submenu?.length) {
                    setExpanded((open) => (open === entry.label ? null : entry.label));
                    return;
                  }
                  onClose();
                  entry.onPress?.();
                }}
                style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
              >
                <MenuIcon name={entry.systemImage} destructive={entry.destructive} />
                <Text
                  numberOfLines={1}
                  style={[styles.itemText, entry.destructive && styles.itemTextDestructive]}
                >
                  {entry.label}
                </Text>
                {entry.submenu?.length ? (
                  <MenuIcon
                    name={expanded === entry.label ? "chevron.down" : "chevron.right"}
                    trailing
                  />
                ) : null}
              </Pressable>
            ))}
          </BlurView>
          {expandedEntries.length ? (
            <BlurView intensity={72} tint={tint} style={[styles.cardBlur, styles.submenu]}>
              {expandedEntries.map((entry) => (
                <Pressable
                  accessibilityRole="button"
                  key={entry.label}
                  onPress={() => {
                    onClose();
                    entry.onPress?.();
                  }}
                  style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
                >
                  <MenuIcon name={entry.systemImage} destructive={entry.destructive} />
                  <Text
                    numberOfLines={1}
                    style={[styles.itemText, entry.destructive && styles.itemTextDestructive]}
                  >
                    {entry.label}
                  </Text>
                </Pressable>
              ))}
            </BlurView>
          ) : null}
        </Animated.View>
      </BlurView>
    </Modal>
  );
}

function MenuIcon({
  name,
  destructive,
  trailing = false,
}: {
  name: string;
  destructive?: boolean;
  trailing?: boolean;
}) {
  const color = destructive
    ? dynColor(tokens.danger, "#FF5A5E")
    : trailing
      ? dynColor(tokens.muted, "#A6A6AE")
      : dynColor(tokens.ink, "#F2F2F4");
  if (Platform.OS !== "ios") return <View style={styles.iconSlot} />;
  return (
    <SymbolView
      name={name as never}
      tintColor={color}
      weight="regular"
      style={styles.iconSlot}
      fallback={<View style={styles.iconSlot} />}
    />
  );
}

const styles = StyleSheet.create({
  accessory: { marginBottom: GAP },
  /** A linha já vem com as margens dela; aqui elas viram o respiro do cartão. */
  highlightRow: { marginHorizontal: 0, marginVertical: 0, minHeight: 0 },
  /**
   * O cartão do item destacado, como no menu de contexto do sistema: a linha inteira,
   * respiro largo, canto grande e uma sombra suave que a solta da lista desfocada.
   */
  highlight: {
    position: "absolute",
    backgroundColor: dynColor(tokens.surface2 ?? "#FFFFFF", "#232327"),
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 12,
    justifyContent: "center",
    shadowColor: "#0B0B0B",
    shadowOpacity: 0.14,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 10 },
  },
  card: {
    position: "absolute",
    width: CARD_WIDTH,
    borderRadius: 22,
    shadowColor: "#0B0B0B",
    shadowOpacity: 0.18,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 12 },
  },
  cardBlur: {
    borderRadius: 22,
    overflow: "hidden",
    paddingVertical: 8,
    backgroundColor: "rgba(246, 246, 246, 0.82)",
  },
  item: {
    height: ITEM_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    paddingHorizontal: 20,
  },
  itemPressed: { backgroundColor: "rgba(120, 120, 128, 0.16)" },
  /** Enquanto o segundo nível está aberto, o primeiro recua sem sumir. */
  cardDimmed: { opacity: 0.5 },
  submenu: { marginTop: 8 },
  iconSlot: { width: 24, height: 24 },
  itemText: {
    color: dynColor(tokens.ink, "#F2F2F4"),
    fontSize: 18,
    fontWeight: "600",
    flexShrink: 1,
  },
  itemTextDestructive: { color: dynColor(tokens.danger, "#FF5A5E") },
});
