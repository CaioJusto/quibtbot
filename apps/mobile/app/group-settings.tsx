import { useLocalSearchParams, useRouter } from "expo-router";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentMark, GroupMark } from "../lib/agent-mark";
import { getGroup, type MobileBot, type MobileGroup, rpc } from "../lib/api";
import { COLORS, GlassIconButton, ScreenHeader } from "../lib/design-system";
import { AppSymbol, showNativeSheet } from "../lib/native";
import { RoutinesSection } from "../lib/routines";

export default function GroupSettings() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { groupId, name: nameParam } = useLocalSearchParams<{
    groupId?: string;
    name?: string;
  }>();
  const nameInput = useRef<TextInput>(null);
  const [group, setGroup] = useState<MobileGroup | null>(null);
  const [name, setName] = useState(nameParam ?? "");
  const [instructions, setInstructions] = useState("");
  const [showInstructions, setShowInstructions] = useState(false);
  const [bots, setBots] = useState<MobileBot[]>([]);
  const [showAddMember, setShowAddMember] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (isActive: () => boolean = () => true) => {
      if (!groupId) return;
      try {
        const next = await getGroup(groupId);
        if (!isActive()) return;
        setGroup(next);
        setName(next.name);
        setInstructions(next.instructions ?? "");
        setError(null);
      } catch (err) {
        if (!isActive()) return;
        setError(err instanceof Error ? err.message : "Não foi possível carregar o grupo");
      }
    },
    [groupId],
  );

  useEffect(() => {
    let active = true;
    void load(() => active);
    void rpc<MobileBot[]>("bots/list")
      .then((rows) => {
        if (!active) return;
        setBots(rows);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Não foi possível carregar os bots");
      });
    return () => {
      active = false;
    };
  }, [load]);

  const members = group?.members ?? [];
  const nonMembers = bots.filter((bot) => !members.some((member) => member.id === bot.id));

  async function saveName() {
    if (!groupId || !name.trim() || name.trim() === group?.name) return;
    setError(null);
    try {
      await rpc("botGroups/update", { groupId, name: name.trim() });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível renomear o grupo");
    }
  }

  async function saveInstructions() {
    if (!groupId) return;
    setError(null);
    try {
      await rpc("botGroups/update", { groupId, instructions });
      setGroup((current) => (current ? { ...current, instructions } : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível salvar as instruções");
    }
  }

  async function addMember(botId: string) {
    if (!groupId) return;
    setError(null);
    try {
      await rpc("botGroups/addMember", { groupId, botId });
      setShowAddMember(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível adicionar o membro");
    }
  }

  function removeMember(member: { id: string; name: string }) {
    if (!groupId) return;
    showNativeSheet({
      title: "Remover membro",
      message: `Remover ${member.name} deste grupo?`,
      actions: [
        {
          label: "Remover",
          destructive: true,
          onPress: () => {
            setError(null);
            void rpc("botGroups/removeMember", { groupId, botId: member.id })
              .then(() => load())
              .catch((err: unknown) =>
                setError(err instanceof Error ? err.message : "Não foi possível remover o membro"),
              );
          },
        },
      ],
    });
  }

  function openMenu() {
    showNativeSheet({
      actions: [
        { label: "Renomear", onPress: () => nameInput.current?.focus() },
        {
          label: "Apagar grupo",
          destructive: true,
          onPress: () => {
            showNativeSheet({
              title: "Apagar grupo",
              message: "Isso remove o grupo e o fio para todo mundo.",
              actions: [
                {
                  label: "Apagar",
                  destructive: true,
                  onPress: () => {
                    if (!groupId) return;
                    void rpc("botGroups/remove", { groupId })
                      .then(() => router.dismissAll())
                      .catch((err: unknown) =>
                        setError(
                          err instanceof Error ? err.message : "Não foi possível apagar o grupo",
                        ),
                      );
                  },
                },
              ],
            });
          },
        },
      ],
    });
  }

  return (
    <View style={{ flex: 1, backgroundColor: COLORS.background }}>
      <ScreenHeader
        onBack={() => router.back()}
        right={<GlassIconButton symbol="ellipsis" label="Opções do grupo" onPress={openMenu} />}
      />
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 92, paddingBottom: insets.bottom + 48 }}
      >
        <View style={{ alignItems: "center", height: 142, justifyContent: "center" }}>
          <GroupMark members={members} size={104} />
        </View>
        <Card>
          <View style={{ padding: 16, alignItems: "center" }}>
            <TextInput
              ref={nameInput}
              value={name}
              onChangeText={setName}
              onEndEditing={() => void saveName()}
              onSubmitEditing={() => void saveName()}
              returnKeyType="done"
              placeholder="Nome do grupo"
              placeholderTextColor={COLORS.tertiary}
              style={{
                color: COLORS.primary,
                fontSize: 20,
                fontWeight: "600",
                textAlign: "center",
                width: "100%",
              }}
            />
          </View>
        </Card>
        <Card header="Membros" footer="Toque e segure um membro para removê-lo.">
          {members.map((member) => (
            <Pressable
              key={member.id}
              onPress={() =>
                router.push({
                  pathname: "/settings",
                  params: {
                    botId: member.id,
                    name: member.name,
                    color: member.color,
                    shape: member.shape ?? "",
                  },
                })
              }
              onLongPress={() => removeMember(member)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                paddingHorizontal: 16,
                paddingVertical: 10,
              }}
            >
              <AgentMark color={member.color} shape={member.shape} size={32} />
              <Text style={{ color: COLORS.primary, fontSize: 16, flex: 1 }}>{member.name}</Text>
              <AppSymbol name="chevron.right" size={20} color={COLORS.tertiary} />
            </Pressable>
          ))}
          <Pressable
            onPress={() => setShowAddMember((value) => !value)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              paddingHorizontal: 16,
              paddingVertical: 12,
            }}
          >
            <AppSymbol name="plus.circle.fill" size={26} color={COLORS.blue} />
            <Text style={{ color: COLORS.blue, fontSize: 16 }}>Adicionar membro</Text>
          </Pressable>
          {showAddMember
            ? nonMembers.map((bot) => (
                <Pressable
                  key={bot.id}
                  onPress={() => void addMember(bot.id)}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    paddingHorizontal: 16,
                    paddingVertical: 10,
                    backgroundColor: COLORS.cardRaised,
                  }}
                >
                  <AgentMark color={bot.color ?? "#FF3B30"} shape={bot.shape} size={26} />
                  <Text style={{ color: COLORS.primary, fontSize: 16 }}>{bot.name}</Text>
                </Pressable>
              ))
            : null}
          {showAddMember && !nonMembers.length ? (
            <Text style={{ color: COLORS.secondary, paddingHorizontal: 16, paddingBottom: 12 }}>
              Todos os bots já estão neste grupo
            </Text>
          ) : null}
        </Card>
        <Card>
          <Pressable
            onPress={() => setShowInstructions((value) => !value)}
            style={{
              padding: 16,
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <Text style={{ color: COLORS.primary, fontSize: 16 }}>Instruções</Text>
            <AppSymbol name="chevron.right" size={20} color={COLORS.tertiary} />
          </Pressable>
        </Card>
        {showInstructions ? (
          <Card>
            <TextInput
              value={instructions}
              onChangeText={setInstructions}
              onEndEditing={() => void saveInstructions()}
              multiline
              placeholder="Instruções compartilhadas para cada membro deste grupo"
              placeholderTextColor={COLORS.tertiary}
              style={{ minHeight: 88, color: COLORS.primary, padding: 12 }}
            />
          </Card>
        ) : null}
        {groupId ? <RoutinesSection groupId={groupId} /> : null}
        {error ? (
          <Text style={{ color: COLORS.red, marginTop: 16, marginHorizontal: 32 }}>{error}</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Card({
  header,
  footer,
  children,
}: {
  header?: string;
  footer?: string;
  children: ReactNode;
}) {
  return (
    <View style={{ marginTop: 24 }}>
      {header ? (
        <Text
          style={{
            color: COLORS.tertiary,
            fontSize: 16,
            fontWeight: "600",
            marginBottom: 10,
            marginLeft: 42,
          }}
        >
          {header}
        </Text>
      ) : null}
      <View
        style={{
          backgroundColor: COLORS.card,
          borderRadius: 16,
          overflow: "hidden",
          marginHorizontal: 24,
        }}
      >
        {children}
      </View>
      {footer ? (
        <Text style={{ color: COLORS.secondary, fontSize: 13, marginTop: 8, marginHorizontal: 32 }}>
          {footer}
        </Text>
      ) : null}
    </View>
  );
}
