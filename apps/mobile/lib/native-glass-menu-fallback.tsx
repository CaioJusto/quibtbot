import { radii, tokens } from "@quibt/ui-tokens";
import * as Haptics from "expo-haptics";
import { type ReactNode, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { AppSymbol, type AppSymbolName } from "./native";

export type FallbackMenuAction = {
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

export function NativeGlassMenuFallback({
  systemImage,
  label,
  actions,
}: {
  systemImage: string;
  label: string;
  actions: FallbackMenuAction[];
}) {
  const [open, setOpen] = useState(false);
  const triggerIcon = MENU_ICON_MAP[systemImage] ?? "ellipsis";

  return (
    <>
      <MenuTrigger>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ expanded: open }}
          onPress={() => {
            void Haptics.selectionAsync().catch(() => undefined);
            setOpen(true);
          }}
          style={({ pressed }) => [styles.trigger, pressed && styles.pressed]}
        >
          <AppSymbol name={triggerIcon} size={23} />
        </Pressable>
      </MenuTrigger>

      <Modal
        animationType="fade"
        onRequestClose={() => setOpen(false)}
        statusBarTranslucent
        transparent
        visible={open}
      >
        <View style={styles.backdrop}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Fechar menu"
            onPress={() => setOpen(false)}
            style={StyleSheet.absoluteFill}
          />
          <View accessibilityRole="menu" style={styles.menu}>
            {actions.map((action, index) => {
              const actionIcon = MENU_ICON_MAP[action.systemImage] ?? "chevron.right";
              return (
                <Pressable
                  accessibilityRole="menuitem"
                  key={action.label}
                  onPress={() => {
                    setOpen(false);
                    void Haptics.selectionAsync().catch(() => undefined);
                    action.onPress();
                  }}
                  style={({ pressed }) => [
                    styles.row,
                    index > 0 && styles.separator,
                    pressed && styles.pressed,
                  ]}
                >
                  <AppSymbol
                    name={actionIcon}
                    size={21}
                    color={action.destructive ? tokens.danger : tokens.ink}
                  />
                  <Text style={[styles.label, action.destructive && styles.destructive]}>
                    {action.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </Modal>
    </>
  );
}

function MenuTrigger({ children }: { children: ReactNode }) {
  return <View style={[styles.triggerSurface, styles.triggerFallback]}>{children}</View>;
}

const styles = StyleSheet.create({
  triggerSurface: {
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: "hidden",
  },
  triggerFallback: {
    backgroundColor: "rgba(252, 252, 252, 0.86)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(20, 20, 20, 0.08)",
  },
  trigger: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  backdrop: {
    flex: 1,
    backgroundColor: tokens.scrim,
  },
  menu: {
    position: "absolute",
    top: 86,
    right: 18,
    width: 236,
    overflow: "hidden",
    borderRadius: radii.xl,
    backgroundColor: tokens.page,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.hairline,
    shadowColor: "#101014",
    shadowOpacity: 0.14,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 14 },
    elevation: 18,
  },
  row: {
    minHeight: 54,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  separator: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.hairline,
  },
  label: {
    color: tokens.ink,
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "600",
  },
  destructive: { color: tokens.danger },
  pressed: { opacity: 0.68 },
});
