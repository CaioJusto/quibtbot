import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import { useRef, useState } from "react";
import { Pressable, StyleSheet, useColorScheme, View } from "react-native";
import { type ContextMenuAnchor, ContextMenuSheet } from "./context-menu-sheet";
import { COLORS } from "./design-system";
import { liquidGlassView } from "./liquid-glass";
import { AppSymbol, type AppSymbolName } from "./native";

export type NativeMenuAction = {
  label: string;
  systemImage: string;
  onPress: () => void;
  destructive?: boolean;
};

const MENU_ICON_MAP: Record<string, AppSymbolName> = {
  plus: "plus",
  ellipsis: "ellipsis",
  "doc.text": "doc.text",
  trash: "trash",
  "person.crop.circle.badge.plus": "person.badge.plus",
  "person.3.fill": "person.2.fill",
};

const CONTROL = 44;

/**
 * No iOS o menu do cabeçalho abre como um cartão translúcido colado ao botão — o
 * desenho do `UIMenu`, com ícone em cada linha. O menu do sistema de verdade só
 * existe via `@expo/ui`, que exige build nativo e não sobe no Expo Go, então aqui é
 * o mesmo cartão do toque longo da lista, ancorado pela direita.
 */
export function NativeGlassMenu({
  systemImage,
  label,
  actions,
}: {
  systemImage: string;
  label: string;
  actions: NativeMenuAction[];
}) {
  const triggerIcon = MENU_ICON_MAP[systemImage] ?? "ellipsis";
  const tint = useColorScheme() === "dark" ? ("dark" as const) : ("light" as const);
  const Glass = liquidGlassView();
  const button = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<ContextMenuAnchor | null>(null);

  const trigger = (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Abre o menu de opções"
      accessibilityLabel={label}
      onPress={() => {
        void Haptics.selectionAsync().catch(() => undefined);
        button.current?.measureInWindow((x, y, width, height) => {
          setAnchor({ x, y, width, height });
          setOpen(true);
        });
      }}
      ref={button}
      style={({ pressed }) => [styles.trigger, pressed && styles.pressed]}
    >
      <AppSymbol name={triggerIcon} size={21} color={COLORS.primary} />
    </Pressable>
  );

  const sheet = (
    <ContextMenuSheet
      alignRight
      anchor={anchor}
      entries={actions.map((action) => ({
        label: action.label,
        systemImage: action.systemImage,
        onPress: action.onPress,
        destructive: action.destructive,
      }))}
      onClose={() => setOpen(false)}
      visible={open}
    />
  );

  if (Glass) {
    return (
      <>
        <Glass
          glassEffectStyle="regular"
          isInteractive
          colorScheme={tint}
          style={styles.nativeGlass}
        >
          {trigger}
        </Glass>
        {sheet}
      </>
    );
  }
  return (
    <>
      <View style={styles.shadow}>
        <BlurView intensity={26} tint={tint} style={styles.surface}>
          {trigger}
        </BlurView>
      </View>
      {sheet}
    </>
  );
}

const styles = StyleSheet.create({
  shadow: {
    width: CONTROL,
    height: CONTROL,
    borderRadius: CONTROL / 2,
    shadowColor: "#0B0B0B",
    shadowOpacity: 0.1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  surface: {
    width: CONTROL,
    height: CONTROL,
    borderRadius: CONTROL / 2,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(20, 20, 20, 0.08)",
    backgroundColor: "rgba(255, 255, 255, 0.92)",
  },
  nativeGlass: {
    width: CONTROL,
    height: CONTROL,
    borderRadius: CONTROL / 2,
    shadowColor: "#0B0B0B",
    shadowOpacity: 0.1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  trigger: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { opacity: 0.62 },
});
