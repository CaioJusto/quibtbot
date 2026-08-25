import { tokens } from "@quibt/ui-tokens";
import Markdown, {
  MarkdownStream,
  type RenderRules,
} from "@ronradtke/react-native-markdown-display";
import { memo } from "react";
import {
  DynamicColorIOS,
  Linking,
  Platform,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import type { ChatMarkdownProps } from "./markdown";
import { sanitizeMarkdownUrl } from "./markdown";

/**
 * A conversa segue o sistema visual do produto: tinta neutra sobre a bolha do bot.
 * No iOS cada cor tem a versão escura (DynamicColorIOS) — sem isso o modo noturno do
 * app deixava a resposta do agente em tinta escura sobre bolha escura, ilegível.
 */
function dyn(light: string, dark: string): string {
  if (Platform.OS !== "ios") return light;
  return DynamicColorIOS({ light, dark }) as unknown as string;
}

const ink = dyn(tokens.ink, "#F2F2F4");
const inset = dyn(tokens.inset, "#2A2A2F");
const hairline = dyn(tokens.hairline, "#35353C");
const mutedEdge = dyn(tokens.muted2, "#787881");

const styles = StyleSheet.create({
  body: {
    color: ink,
    fontSize: 16,
    lineHeight: 23,
    width: "100%",
    minWidth: 0,
    flexShrink: 1,
  },
  paragraph: {
    marginTop: 0,
    marginBottom: 9,
    width: "100%",
    flexShrink: 1,
  },
  heading1: {
    color: ink,
    fontSize: 20,
    lineHeight: 26,
    marginTop: 10,
    marginBottom: 5,
  },
  heading2: {
    color: ink,
    fontSize: 18,
    lineHeight: 24,
    marginTop: 10,
    marginBottom: 5,
  },
  heading3: {
    color: ink,
    fontSize: 16,
    lineHeight: 22,
    marginTop: 8,
    marginBottom: 4,
  },
  strong: {
    color: ink,
    fontWeight: "700",
  },
  link: {
    color: tokens.accent,
    textDecorationLine: "underline",
    marginBottom: 0,
  },
  code_inline: {
    color: ink,
    backgroundColor: inset,
    borderColor: hairline,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 0,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
  },
  code_block: {
    color: ink,
    backgroundColor: inset,
    borderColor: hairline,
  },
  fence: {
    backgroundColor: inset,
    borderColor: hairline,
  },
  fence_code: {
    backgroundColor: inset,
  },
  blockquote: {
    backgroundColor: "transparent",
    borderLeftColor: mutedEdge,
  },
  table: {
    borderColor: hairline,
  },
  tr: {
    borderColor: hairline,
  },
  hr: {
    backgroundColor: hairline,
  },
  bullet_list_content: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  ordered_list_content: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
  },
});

async function openSafeLink(url: string) {
  const safeUrl = sanitizeMarkdownUrl(url);
  if (!safeUrl) return;
  if (await Linking.canOpenURL(safeUrl)) await Linking.openURL(safeUrl);
}

// Keep links as Text so they stay inside textgroup; Pressable (a View) is laid out
// outside the text flow and collapses the bubble height, overlapping later messages.
const renderRules: RenderRules = {
  link: (node, children, _parent, styleMap) => (
    <Text
      accessibilityRole="link"
      key={node.key}
      style={styleMap.link}
      onPress={() => {
        void openSafeLink(node.attributes.href ?? "");
      }}
    >
      {children}
    </Text>
  ),
};

export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  streaming = false,
}: ChatMarkdownProps) {
  const scheme = useColorScheme();
  const sharedProps = {
    colorScheme: (scheme === "dark" ? "dark" : "light") as "light" | "dark",
    style: styles,
    rules: renderRules,
    allowedImageHandlers: ["https://", "http://"],
    onLinkPress: (url: string) => {
      void openSafeLink(url);
      return false;
    },
  };

  return (
    <View style={layout.wrap}>
      {streaming ? (
        // O cursor da biblioteca é um View solto depois do texto: cai numa linha
        // própria e vira um "traço" abaixo da bolha. Enquanto o bot escreve, o
        // próprio texto crescendo já mostra que está vindo mais.
        <MarkdownStream {...sharedProps} cursorStyle={layout.noCursor} streaming>
          {children}
        </MarkdownStream>
      ) : (
        <Markdown {...sharedProps}>{children}</Markdown>
      )}
    </View>
  );
});

const layout = StyleSheet.create({
  wrap: {
    width: "100%",
    minWidth: 0,
    flexShrink: 1,
  },
  noCursor: { width: 0, height: 0, marginTop: 0 },
});

export type { ChatMarkdownProps } from "./markdown";
