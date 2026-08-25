import Constants, { ExecutionEnvironment } from "expo-constants";
import { type ComponentType, type ReactNode, useRef, useState } from "react";
import { Animated, Pressable, type View, type ViewStyle } from "react-native";
import { type ContextMenuAnchor, ContextMenuSheet } from "./context-menu-sheet";
import { softHaptic } from "./design-system";

export type BotMenuItem = {
  label: string;
  /** Nome de SF Symbol; só aparece no menu nativo do dev build. */
  systemImage: string;
  onPress?: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** Segundo nível, como o "Mais" do menu do sistema. */
  submenu?: BotMenuItem[];
};

type SwiftUiModule = {
  Host: ComponentType<Record<string, unknown>>;
  ContextMenu: ComponentType<{ children: ReactNode }> & {
    Trigger: ComponentType<{ children: ReactNode }>;
    Items: ComponentType<{ children: ReactNode }>;
    Preview: ComponentType<{ children: ReactNode }>;
  };
  Button: ComponentType<Record<string, unknown>>;
};

let cached: SwiftUiModule | null | undefined;

/**
 * O `.contextMenu` do SwiftUI — o item sobe destacado e o menu abre translúcido,
 * com os ícones do sistema. `@expo/ui` não existe no Expo Go, e lá o require nem dá
 * para tentar: ele registra uma view nativa ausente e derruba o app antes de o
 * try/catch do JS ver qualquer coisa. Por isso o Expo Go é descartado pelo
 * `executionEnvironment` primeiro, e só um build nativo chega ao require.
 */
function swiftUi(): SwiftUiModule | null {
  if (cached !== undefined) return cached;
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
    cached = null;
    return cached;
  }
  // O Host do SwiftUI com `matchContents` mede os filhos pelo tamanho intrínseco do
  // SwiftUI — e a linha, que é uma view do React Native, não tem nenhum: no aparelho de
  // verdade ela aparecia por um instante e recolhia para zero, e a caixa de entrada
  // ficava "vazia". Até isso ter um tamanho confiável, o menu do sistema fica atrás de
  // uma bandeira e a linha usa o menu em folha, que mede a si mesma.
  if (process.env.EXPO_PUBLIC_NATIVE_CONTEXT_MENU !== "1") {
    cached = null;
    return cached;
  }
  try {
    const mod = require("@expo/ui/swift-ui") as SwiftUiModule;
    cached = mod.ContextMenu && mod.Host ? mod : null;
  } catch {
    cached = null;
  }
  return cached;
}

export function BotContextMenu({
  items,
  onPress,
  onMenuOpen,
  accessibilityLabel,
  style,
  children,
  highlight,
}: {
  items: BotMenuItem[];
  onPress: () => void;
  /** Só dispara no caminho do action sheet, onde o toque longo pode virar toque. */
  onMenuOpen?: () => void;
  accessibilityLabel?: string;
  style?: ViewStyle | ViewStyle[];
  children: ReactNode;
  /** Resumo que sobe no cartão; sem ele, a própria linha. */
  highlight?: ReactNode;
}) {
  const ui = swiftUi();
  const enabled = items.filter((item) => !item.disabled);
  const rowRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<ContextMenuAnchor | null>(null);
  // O pulso do iOS: encolhe de leve enquanto o dedo está em cima e volta ao soltar.
  const press = useRef(new Animated.Value(1)).current;
  const pulse = (toValue: number) =>
    Animated.spring(press, {
      toValue,
      useNativeDriver: true,
      speed: 40,
      bounciness: 4,
    }).start();

  if (!ui) {
    return (
      <>
        <Pressable
          accessibilityHint="Toque para abrir. Toque e segure para mais opções."
          accessibilityLabel={accessibilityLabel}
          delayLongPress={400}
          onLongPress={() => {
            onMenuOpen?.();
            softHaptic();
            // Mede onde a linha está na janela para o menu nascer colado nela.
            rowRef.current?.measureInWindow((x, y, width, height) => {
              setAnchor({ x, y, width, height });
              setOpen(true);
            });
          }}
          onPress={onPress}
          onPressIn={() => pulse(0.97)}
          onPressOut={() => pulse(1)}
          ref={rowRef}
        >
          <Animated.View style={[style, { transform: [{ scale: press }] }]}>
            {children}
          </Animated.View>
        </Pressable>
        <ContextMenuSheet
          anchor={anchor}
          entries={enabled.map((item) => ({
            label: item.label,
            systemImage: item.systemImage,
            onPress: item.onPress,
            destructive: item.destructive,
            submenu: item.submenu?.filter((child) => !child.disabled),
          }))}
          highlight={highlight}
          onClose={() => setOpen(false)}
          rowStyle={style}
          visible={open}
        >
          {children}
        </ContextMenuSheet>
      </>
    );
  }

  const { Host, ContextMenu, Button } = ui;
  const row = (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Toque para abrir. Toque e segure para mais opções."
      onPress={onPress}
      style={style}
    >
      {children}
    </Pressable>
  );

  return (
    <Host matchContents={{ vertical: true }}>
      <ContextMenu>
        <ContextMenu.Items>
          {/*
            O menu do sistema aninha de verdade, com `ContextMenu` dentro de
            `ContextMenu`. Aqui as ações do "Mais" entram achatadas: no `UIMenu` a
            lista já rola e esconder duas linhas atrás de um nível a mais custaria
            mais toque do que economiza.
          */}
          {enabled
            .flatMap((item) => (item.submenu?.length ? item.submenu : [item]))
            .filter((item) => !item.disabled)
            .map((item) => (
              <Button
                key={item.label}
                label={item.label}
                systemImage={item.systemImage}
                role={item.destructive ? "destructive" : undefined}
                onPress={item.onPress}
              />
            ))}
        </ContextMenu.Items>
        <ContextMenu.Trigger>{row}</ContextMenu.Trigger>
      </ContextMenu>
    </Host>
  );
}
