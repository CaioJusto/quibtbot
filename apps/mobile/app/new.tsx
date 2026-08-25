import { DEFAULT_MARK_COLOR, formatAppearance, type MarkShape } from "@quibt/ui-tokens";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentMark } from "../lib/agent-mark";
import { type MobileBot, rpc } from "../lib/api";
import { CharacterPicker } from "../lib/character-picker";
import {
  COLORS,
  ScreenHeader,
  SectionCard,
  SectionLabel,
  Separator,
  useHeaderContentInset,
} from "../lib/design-system";
import { isPlanLimitError } from "../lib/plans";

export default function NewBot() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const topInset = useHeaderContentInset(12, true);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(DEFAULT_MARK_COLOR);
  const [shape, setShape] = useState<MarkShape>("strobi");
  const [error, setError] = useState<string | null>(null);
  const [planLimitError, setPlanLimitError] = useState(false);
  const [pending, setPending] = useState(false);

  function close() {
    if (router.canDismiss()) router.dismiss();
    else if (router.canGoBack()) router.back();
    else router.replace("/");
  }

  async function create() {
    if (!name.trim() || pending) return;
    setPending(true);
    setError(null);
    setPlanLimitError(false);
    try {
      const bot = await rpc<MobileBot>("bots/create", {
        name: name.trim(),
        title,
        description,
        instructions: description,
        notifyOnFinish: true,
        color: formatAppearance({ color, shape }),
        shape,
      });
      // A cor e o formato vão junto: a conversa abre já com o personagem escolhido, não
      // com o azul padrão até a próxima carga.
      router.replace({
        pathname: "/thread",
        params: {
          botId: bot.id,
          name: bot.name,
          color: bot.color ?? formatAppearance({ color, shape }),
          shape: bot.shape ?? shape,
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível criar o bot");
      setPlanLimitError(isPlanLimitError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <View style={styles.screen}>
      <ScreenHeader onBack={close} modal />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingTop: topInset, paddingBottom: insets.bottom + 44 }}
      >
        <View style={styles.hero}>
          <AgentMark color={color} shape={shape} size={104} />
        </View>
        <View style={styles.pageInset}>
          <SectionCard>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Nome do bot"
              placeholderTextColor={COLORS.tertiary}
              style={styles.nameField}
            />
            <Separator inset={18} />
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="Cargo (opcional)"
              placeholderTextColor={COLORS.tertiary}
              style={styles.titleField}
            />
          </SectionCard>

          <SectionLabel>Personagem</SectionLabel>
          <CharacterPicker
            color={color}
            shape={shape}
            onChange={(next) => {
              setColor(next.color);
              setShape(next.shape);
            }}
          />
          <Text style={styles.footer}>Como este bot aparece em todo lugar</Text>

          <SectionLabel>Instruções</SectionLabel>
          <SectionCard>
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="Como este bot deve trabalhar?"
              placeholderTextColor={COLORS.tertiary}
              multiline
              style={styles.instructions}
            />
          </SectionCard>

          {error ? (
            <Pressable disabled={!planLimitError} onPress={() => router.push("/billing")}>
              <Text style={styles.error}>
                {error}
                {planLimitError ? "  Ver planos" : ""}
              </Text>
            </Pressable>
          ) : null}

          <Pressable
            onPress={() => void create()}
            disabled={!name.trim() || pending}
            style={[styles.create, (!name.trim() || pending) && styles.disabled]}
          >
            <Text style={styles.createText}>{pending ? "Criando…" : "Criar agente"}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  hero: { height: 120, alignItems: "center", justifyContent: "center" },
  pageInset: { paddingHorizontal: 24 },
  nameField: {
    minHeight: 56,
    color: COLORS.primary,
    fontSize: 21,
    fontWeight: "700",
    textAlign: "center",
    paddingHorizontal: 18,
  },
  titleField: {
    minHeight: 50,
    color: COLORS.secondary,
    fontSize: 17,
    fontWeight: "600",
    textAlign: "center",
    paddingHorizontal: 18,
  },
  footer: {
    color: COLORS.tertiary,
    fontSize: 15,
    lineHeight: 20,
    marginTop: 9,
    marginHorizontal: 18,
  },
  instructions: {
    minHeight: 132,
    color: COLORS.primary,
    fontSize: 16,
    lineHeight: 22,
    padding: 18,
    textAlignVertical: "top",
  },
  error: { color: COLORS.red, marginTop: 16, fontSize: 15 },
  create: {
    marginTop: 24,
    minHeight: 54,
    borderRadius: 16,
    backgroundColor: COLORS.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.35 },
  createText: { color: COLORS.background, fontSize: 17, fontWeight: "700" },
});
