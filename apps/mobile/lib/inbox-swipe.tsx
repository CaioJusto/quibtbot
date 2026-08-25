import { tokens } from "@quibt/ui-tokens";
import type { ReactNode } from "react";
import { Pressable, StyleSheet } from "react-native";
import ReanimatedSwipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import Reanimated, { type SharedValue, useAnimatedStyle } from "react-native-reanimated";
import { AppSymbol, type AppSymbolName } from "./native";

export type SwipeAction = {
  label: string;
  symbol: AppSymbolName;
  color: string;
  onPress: () => void;
};

/** As cores das faixas: a do sistema para conversa, âmbar para esconder, cinza para fixar. */
export const SWIPE_COLORS = {
  unread: tokens.accent,
  pin: "#8A8A8E",
  hide: "#A9760F",
} as const;

const ACTION_WIDTH = 84;

/**
 * A linha da caixa de entrada que anda com o dedo, como em qualquer lista do iOS:
 * puxar para a esquerda mostra fixar e esconder, puxar para a direita marca como não
 * lida. As duas coisas já existiam no toque longo — aqui elas ficam a um gesto de
 * distância, que é como a pessoa espera de uma lista de conversas.
 */
export function SwipeableRow({
  leading,
  trailing,
  children,
}: {
  leading?: SwipeAction;
  trailing?: SwipeAction[];
  children: ReactNode;
}) {
  return (
    <ReanimatedSwipeable
      friction={2}
      leftThreshold={ACTION_WIDTH * 0.6}
      rightThreshold={ACTION_WIDTH * 0.6}
      overshootLeft={false}
      overshootRight={false}
      renderLeftActions={
        leading
          ? (_progress, translation) => <Side actions={[leading]} drag={translation} />
          : undefined
      }
      renderRightActions={
        trailing?.length
          ? (_progress, translation) => <Side actions={trailing} drag={translation} trailing />
          : undefined
      }
    >
      {children}
    </ReanimatedSwipeable>
  );
}

function Side({
  actions,
  drag,
  trailing = false,
}: {
  actions: SwipeAction[];
  drag: SharedValue<number>;
  trailing?: boolean;
}) {
  const width = ACTION_WIDTH * actions.length;
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: trailing ? drag.value + width : drag.value - width }],
  }));
  return (
    <Reanimated.View style={[styles.side, { width }, style]}>
      {actions.map((action) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={action.label}
          key={action.label}
          onPress={action.onPress}
          style={({ pressed }) => [
            styles.action,
            { backgroundColor: action.color },
            pressed && styles.pressed,
          ]}
        >
          <AppSymbol name={action.symbol} size={24} color="#FFFFFF" />
        </Pressable>
      ))}
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  side: { flexDirection: "row" },
  action: { width: ACTION_WIDTH, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.75 },
});
