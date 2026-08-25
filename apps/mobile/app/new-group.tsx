import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentMark, GroupMark } from "../lib/agent-mark";
import { type MobileBot, rpc } from "../lib/api";
import {
  COLORS,
  ScreenHeader,
  SectionCard,
  Separator,
  useHeaderContentInset,
} from "../lib/design-system";
import { AppSymbol } from "../lib/native";

export default function NewGroup() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const topInset = useHeaderContentInset(12, true);
  const [name, setName] = useState("");
  const [bots, setBots] = useState<MobileBot[]>([]);
  const [botIds, setBotIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void rpc<MobileBot[]>("bots/list")
      .then(setBots)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Não foi possível carregar os bots"),
      );
  }, []);

  async function create() {
    if (!name.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const group = await rpc<{ id: string; name: string }>("botGroups/create", {
        name: name.trim(),
        botIds,
      });
      router.replace({ pathname: "/thread", params: { groupId: group.id, name: group.name } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível criar o grupo");
    } finally {
      setCreating(false);
    }
  }

  const selected = bots
    .filter((bot) => botIds.includes(bot.id))
    .map((bot) => ({
      id: bot.id,
      name: bot.name,
      color: bot.color ?? COLORS.secondary,
      shape: bot.shape,
    }));

  return (
    <View style={styles.screen}>
      <ScreenHeader onBack={() => router.back()} modal />
      <ScrollView
        contentContainerStyle={{ paddingTop: topInset, paddingBottom: insets.bottom + 44 }}
      >
        <View style={styles.hero}>
          <GroupMark members={selected} size={104} />
        </View>
        <View style={styles.pageInset}>
          <SectionCard>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Nome do grupo"
              placeholderTextColor={COLORS.tertiary}
              style={styles.nameField}
            />
          </SectionCard>

          <Text style={styles.sectionLabel}>Membros</Text>
          <SectionCard>
            {bots.map((bot, index) => {
              const on = botIds.includes(bot.id);
              return (
                <View key={bot.id}>
                  {index ? <Separator inset={62} /> : null}
                  <Pressable
                    onPress={() =>
                      setBotIds((ids) =>
                        on ? ids.filter((id) => id !== bot.id) : [...ids, bot.id],
                      )
                    }
                    style={styles.memberRow}
                  >
                    <AgentMark color={bot.color ?? COLORS.secondary} shape={bot.shape} size={38} />
                    <Text style={styles.memberName}>{bot.name}</Text>
                    {on ? (
                      <AppSymbol name="checkmark.circle.fill" size={22} color={COLORS.blue} />
                    ) : null}
                  </Pressable>
                </View>
              );
            })}
          </SectionCard>

          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable
            onPress={() => void create()}
            disabled={!name.trim() || creating}
            style={[styles.create, (!name.trim() || creating) && styles.disabled]}
          >
            <Text style={styles.createText}>{creating ? "Criando…" : "Criar grupo"}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  hero: { height: 142, alignItems: "center", justifyContent: "center" },
  pageInset: { paddingHorizontal: 24 },
  nameField: {
    minHeight: 58,
    color: COLORS.primary,
    fontSize: 21,
    fontWeight: "700",
    textAlign: "center",
    paddingHorizontal: 18,
  },
  sectionLabel: {
    color: COLORS.tertiary,
    fontSize: 16,
    fontWeight: "600",
    marginTop: 28,
    marginBottom: 10,
    marginLeft: 18,
  },
  memberRow: {
    minHeight: 64,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  memberName: { color: COLORS.primary, fontSize: 18, fontWeight: "600", flex: 1 },
  error: { color: COLORS.red, marginTop: 16 },
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
