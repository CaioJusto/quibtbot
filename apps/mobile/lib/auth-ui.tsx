import { radii } from "@quibt/ui-tokens";
import type { ReactNode } from "react";
import { Platform, StyleSheet, Text, type TextStyle, View, type ViewStyle } from "react-native";
import { COLORS } from "./design-system";

/**
 * As telas de entrada usam o mesmo sistema visual do resto do produto (com a versão
 * escura vindo da mesma paleta dinâmica). Como no web, o formulário fica sobre a
 * própria página: quem separa as coisas é o espaço, não uma moldura.
 */
export const AUTH_BG = COLORS.rail;

export const AUTH_FRAME: ViewStyle = {
  width: "100%",
  maxWidth: 460,
  alignSelf: "center",
  paddingHorizontal: 24,
  paddingVertical: 28,
};

export const AUTH_PANEL: ViewStyle = {
  marginTop: 22,
};

export const AUTH_FIELD: ViewStyle = {
  marginTop: 6,
  minHeight: 52,
  backgroundColor: COLORS.background,
  borderRadius: radii.md,
  borderWidth: StyleSheet.hairlineWidth,
  borderColor: COLORS.separator,
  paddingHorizontal: 14,
  paddingVertical: Platform.OS === "ios" ? 14 : 12,
};

export const AUTH_FIELD_TEXT: TextStyle = {
  color: COLORS.primary,
  fontSize: 16,
};

export const AUTH_PLACEHOLDER = COLORS.tertiary;

export const AUTH_BUTTON: ViewStyle = {
  minHeight: 52,
  marginTop: 22,
  backgroundColor: COLORS.primaryStrong,
  borderRadius: 999,
  paddingVertical: 14,
  alignItems: "center",
  justifyContent: "center",
};

export const AUTH_BUTTON_TEXT: TextStyle = {
  color: COLORS.background,
  fontSize: 17,
  fontWeight: "600",
};

export function AuthMessage({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "error" | "success";
}) {
  return (
    <View style={[styles.message, tone === "success" ? styles.success : styles.error]}>
      <View style={[styles.messageDot, tone === "success" ? styles.successDot : styles.errorDot]} />
      <Text
        style={[styles.messageText, tone === "success" ? styles.successText : styles.errorText]}
      >
        {children}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  message: {
    minHeight: 46,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 13,
    paddingVertical: 11,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    marginTop: 16,
  },
  success: { backgroundColor: "#E4EFE6", borderColor: "#BEDCC5" },
  error: { backgroundColor: COLORS.redSoft, borderColor: "#DFBFC1" },
  messageDot: { width: 7, height: 7, borderRadius: 4, marginTop: 6 },
  successDot: { backgroundColor: COLORS.green },
  errorDot: { backgroundColor: COLORS.red },
  messageText: { flex: 1, fontSize: 13, lineHeight: 19 },
  successText: { color: "#1F6B33" },
  errorText: { color: "#A32D31" },
});
