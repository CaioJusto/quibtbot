import type { MemoryDocument } from "@quibt/contracts";
import { formatMemoryUsageFromRaw } from "@quibt/core";
import { formatAppearance, parseAppearance } from "@quibt/ui-tokens";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentMark } from "../lib/agent-mark";
import { type MobileBot, rpc } from "../lib/api";
import {
  buildExportSharePayload,
  duplicateBotNavigationTarget,
  MEMORY_CHAR_LIMIT,
  memoryListBotPayload,
  memoryListUserPayload,
  memoryOverLimit,
  memoryUpdatePayload,
  splitMobileMemoryDocs,
  USER_CHAR_LIMIT,
} from "../lib/bot-tools";
import { CharacterPicker } from "../lib/character-picker";
import { defaultDemoInstructions, demoBotForId, isDemoBotId } from "../lib/demo-inbox";
import { loadDemoBotSettings, saveDemoBotSettings } from "../lib/demo-inbox-store";
import {
  COLORS,
  NativeGlassMenu,
  ScreenHeader,
  SectionCard,
  SectionLabel,
  Separator,
} from "../lib/design-system";
import { AppSymbol } from "../lib/native";
import { RoutinesSection } from "../lib/routines";

type MemoryScope = "bot" | "user";

export default function Settings() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { botId, name, color, shape, demo } = useLocalSearchParams<{
    botId?: string;
    name?: string;
    color?: string;
    shape?: string;
    demo?: string;
  }>();
  const isDemo = demo === "1" || isDemoBotId(botId);
  const initial = parseAppearance(typeof color === "string" ? color : "");
  const initialColor = initial.color;
  const initialShape = initial.shape;
  const [markColor, setMarkColor] = useState(initialColor);
  const [markShape, setMarkShape] = useState(shape || initialShape);
  const [botName, setBotName] = useState(typeof name === "string" ? name : "");
  const [title, setTitle] = useState("");
  const [notify, setNotify] = useState(true);
  const [instructions, setInstructions] = useState("");
  const [showInstructions, setShowInstructions] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [clearError, setClearError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showMemory, setShowMemory] = useState(false);
  const [memoryBotDoc, setMemoryBotDoc] = useState<MemoryDocument | undefined>();
  const [memoryUserDoc, setMemoryUserDoc] = useState<MemoryDocument | undefined>();
  const [memoryBotText, setMemoryBotText] = useState("");
  const [memoryUserText, setMemoryUserText] = useState("");
  const [memorySaving, setMemorySaving] = useState<MemoryScope | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState(false);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!botId) {
      return () => {
        active = false;
      };
    }
    if (isDemo) {
      void loadDemoBotSettings().then((overrides) => {
        if (!active) return;
        const bot = demoBotForId(botId, overrides);
        setBotName(bot.name);
        setTitle(bot.title);
        setNotify(overrides[bot.id]?.notifyOnFinish ?? true);
        setInstructions(overrides[bot.id]?.instructions ?? defaultDemoInstructions(bot.id));
        setMarkColor(bot.color ?? initialColor);
        setMarkShape(bot.shape ?? initialShape);
      });
      return () => {
        active = false;
      };
    }
    void rpc<{
      name: string;
      title: string;
      notifyOnFinish: boolean;
      instructions: string;
      color: string;
      shape?: string;
    }>("bots/get", { botId })
      .then((bot) => {
        if (!active) return;
        const next = parseAppearance(bot.color);
        setBotName(bot.name);
        setTitle(bot.title);
        setNotify(bot.notifyOnFinish);
        setInstructions(bot.instructions);
        setMarkColor(next.color);
        setMarkShape(bot.shape || next.shape);
        setSaveError(null);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setSaveError(err instanceof Error ? err.message : "Não foi possível carregar o bot");
      });
    return () => {
      active = false;
    };
  }, [botId, initialColor, initialShape, isDemo]);

  useEffect(() => {
    let active = true;
    if (!botId || isDemo) {
      return () => {
        active = false;
      };
    }
    void Promise.all([
      rpc<MemoryDocument[]>("memory/list", memoryListBotPayload(botId)),
      rpc<MemoryDocument[]>("memory/list", memoryListUserPayload()),
    ])
      .then(([botDocs, userDocs]) => {
        if (!active) return;
        const split = splitMobileMemoryDocs([...botDocs, ...userDocs]);
        setMemoryBotDoc(split.bot);
        setMemoryUserDoc(split.user);
        setMemoryBotText(split.bot?.content ?? "");
        setMemoryUserText(split.user?.content ?? "");
      })
      .catch((err: unknown) => {
        if (!active) return;
        setMemoryError(err instanceof Error ? err.message : "Não foi possível ler a memória");
      });
    return () => {
      active = false;
    };
  }, [botId, isDemo]);

  async function saveMemory(scope: MemoryScope) {
    const doc = scope === "bot" ? memoryBotDoc : memoryUserDoc;
    const text = scope === "bot" ? memoryBotText : memoryUserText;
    if (memoryOverLimit(text, scope)) {
      const limit = scope === "bot" ? MEMORY_CHAR_LIMIT : USER_CHAR_LIMIT;
      setMemoryError(
        `${scope === "bot" ? "MEMORY.md" : "USER.md"} passou de ${limit.toLocaleString("pt-BR")} caracteres. Junte ou apague entradas (separadas por §) e tente de novo.`,
      );
      return;
    }
    if (!doc) {
      setMemoryError("Ainda não há um arquivo de memória para salvar.");
      return;
    }
    setMemorySaving(scope);
    setMemoryError(null);
    try {
      const updated = await rpc<MemoryDocument>("memory/update", memoryUpdatePayload(doc.id, text));
      if (scope === "bot") setMemoryBotDoc(updated);
      else setMemoryUserDoc(updated);
    } catch (err) {
      setMemoryError(err instanceof Error ? err.message : "Não foi possível salvar a memória");
    } finally {
      setMemorySaving(null);
    }
  }

  async function duplicateBot() {
    if (!botId || isDemo || duplicating) return;
    setDuplicating(true);
    setDuplicateError(null);
    try {
      const copy = await rpc<MobileBot>("bots/duplicate", { botId });
      router.replace(duplicateBotNavigationTarget(copy));
    } catch (err) {
      setDuplicateError(err instanceof Error ? err.message : "Não foi possível duplicar o bot");
      setDuplicating(false);
    }
  }

  async function exportBot() {
    if (!botId || isDemo || exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      const manifest = await rpc("export/bot", { botId });
      const payload = buildExportSharePayload(botName.trim() || name || "bot", manifest);
      const [FileSystem, Sharing] = await Promise.all([
        import("expo-file-system/legacy"),
        import("expo-sharing"),
      ]);
      const dest = `${FileSystem.cacheDirectory}${payload.fileName}`;
      await FileSystem.writeAsStringAsync(dest, payload.contents);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(dest);
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Não foi possível exportar o bot");
    } finally {
      setExporting(false);
    }
  }

  async function persist(nextColor = markColor, nextShape = markShape) {
    if (!botId) return;
    setSaveError(null);
    try {
      if (isDemo) {
        await saveDemoBotSettings(botId, {
          color: nextColor,
          shape: nextShape,
          name: botName.trim() || name || "Bot",
          title,
          notifyOnFinish: notify,
          instructions,
        });
        return;
      }
      await rpc("bots/update", {
        botId,
        color: formatAppearance({ color: nextColor, shape: nextShape as never }),
        shape: nextShape,
        name: botName.trim() || name,
        title,
        notifyOnFinish: notify,
        instructions,
      });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Não foi possível salvar o bot");
    }
  }

  async function persistNotify(value: boolean) {
    if (!botId) return;
    const previous = notify;
    setNotify(value);
    setSaveError(null);
    try {
      if (isDemo) await saveDemoBotSettings(botId, { notifyOnFinish: value });
      else await rpc("bots/update", { botId, notifyOnFinish: value });
    } catch (err) {
      setNotify(previous);
      setSaveError(err instanceof Error ? err.message : "Não foi possível salvar a notificação");
    }
  }

  async function clearConversation() {
    if (!botId) return;
    setClearing(true);
    setClearError(null);
    try {
      await rpc("threads/clear", { botId });
      setConfirmClear(false);
      router.back();
    } catch (err) {
      setClearError(err instanceof Error ? err.message : "Não foi possível limpar a conversa");
    } finally {
      setClearing(false);
    }
  }

  async function removeBot() {
    if (!botId) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await rpc("bots/remove", { botId });
      router.replace("/");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Não foi possível apagar o bot");
      setDeleting(false);
    }
  }

  const moreActions = [
    {
      label: "Instruções",
      systemImage: "doc.text",
      onPress: () => setShowInstructions(true),
    },
    ...(!isDemo
      ? [
          {
            label: "Memória",
            systemImage: "doc.text",
            onPress: () => setShowMemory(true),
          },
          {
            label: "Duplicar bot",
            systemImage: "doc.on.doc",
            onPress: () => void duplicateBot(),
          },
          {
            label: "Exportar bot",
            systemImage: "square.and.arrow.up",
            onPress: () => void exportBot(),
          },
          {
            label: "Limpar conversa",
            systemImage: "eraser",
            onPress: () => {
              setConfirmDelete(false);
              setConfirmClear(true);
            },
          },
          {
            label: "Apagar bot",
            systemImage: "trash",
            destructive: true,
            onPress: () => {
              setConfirmClear(false);
              setConfirmDelete(true);
            },
          },
        ]
      : []),
  ];

  return (
    <View style={styles.screen}>
      <ScreenHeader
        onBack={() => router.back()}
        right={
          <View accessibilityLabel="Opções do bot">
            <NativeGlassMenu systemImage="ellipsis" label="Mais" actions={moreActions} />
          </View>
        }
      />
      <ScrollView
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: insets.top + 92, paddingBottom: insets.bottom + 44 }}
      >
        <View style={styles.hero}>
          <AgentMark color={markColor} shape={markShape} size={104} />
        </View>

        <View style={styles.pageInset}>
          <SectionCard>
            <TextInput
              value={botName}
              onChangeText={setBotName}
              onEndEditing={() => void persist()}
              placeholder="Nome"
              placeholderTextColor={COLORS.tertiary}
              style={styles.nameField}
            />
            <Separator inset={18} />
            <TextInput
              value={title}
              onChangeText={setTitle}
              onEndEditing={() => void persist()}
              placeholder="Cargo (opcional)"
              placeholderTextColor={COLORS.tertiary}
              style={styles.titleField}
            />
          </SectionCard>

          <SectionLabel>Personagem</SectionLabel>
          <CharacterPicker
            color={markColor}
            shape={markShape}
            onChange={(next) => {
              setMarkColor(next.color);
              setMarkShape(next.shape);
              void persist(next.color, next.shape);
            }}
          />
          <Text style={styles.footerText}>Como a marca deste agente aparece em todo lugar</Text>

          <View style={styles.sectionGap}>
            <SectionCard>
              <Pressable
                onPress={() => setShowInstructions((value) => !value)}
                style={styles.actionRow}
              >
                <AppSymbol name="doc.text" size={22} color={COLORS.secondary} />
                <Text style={styles.actionTitle}>Instruções</Text>
                <AppSymbol name="chevron.right" size={20} color={COLORS.tertiary} />
              </Pressable>
              {showInstructions ? (
                <>
                  <Separator inset={54} />
                  <TextInput
                    value={instructions}
                    onChangeText={setInstructions}
                    onEndEditing={() => void persist()}
                    placeholder="Como este agente deve trabalhar?"
                    placeholderTextColor={COLORS.tertiary}
                    multiline
                    style={styles.instructions}
                  />
                </>
              ) : null}
            </SectionCard>
          </View>

          {!isDemo ? (
            <View style={styles.sectionGap}>
              <SectionCard>
                <Pressable
                  onPress={() => setShowMemory((value) => !value)}
                  style={styles.actionRow}
                >
                  <AppSymbol name="doc.text" size={22} color={COLORS.secondary} />
                  <Text style={styles.actionTitle}>Memória</Text>
                  <AppSymbol name="chevron.right" size={20} color={COLORS.tertiary} />
                </Pressable>
                {showMemory ? (
                  <>
                    <Separator inset={54} />
                    <View style={styles.memoryBody}>
                      <Text style={styles.memoryIntro}>
                        Memória no estilo Hermes: {botName || name || "o bot"} lê um retrato dela no
                        início do turno. MEMORY.md são as notas do agente; USER.md é o perfil da sua
                        conta. Separe entradas com §.
                      </Text>
                      <MemoryField
                        label="MEMORY.md — notas do agente"
                        usage={formatMemoryUsageFromRaw(memoryBotText, "memory")}
                        value={memoryBotText}
                        saving={memorySaving === "bot"}
                        onChange={setMemoryBotText}
                        onSave={() => void saveMemory("bot")}
                      />
                      <MemoryField
                        label="USER.md — perfil"
                        usage={formatMemoryUsageFromRaw(memoryUserText, "user")}
                        value={memoryUserText}
                        saving={memorySaving === "user"}
                        onChange={setMemoryUserText}
                        onSave={() => void saveMemory("user")}
                      />
                      {memoryError ? <Text style={styles.deleteError}>{memoryError}</Text> : null}
                    </View>
                  </>
                ) : null}
              </SectionCard>
            </View>
          ) : null}

          {!isDemo ? (
            <View style={styles.sectionGap}>
              <SectionCard>
                <Pressable
                  onPress={() => void duplicateBot()}
                  disabled={duplicating}
                  style={styles.actionRow}
                >
                  <AppSymbol name="doc.on.doc" size={22} color={COLORS.secondary} />
                  <Text style={styles.actionTitle}>
                    {duplicating ? "Duplicando…" : "Duplicar bot"}
                  </Text>
                  {duplicating ? <ActivityIndicator /> : null}
                </Pressable>
                <Separator inset={54} />
                <Pressable
                  onPress={() => void exportBot()}
                  disabled={exporting}
                  style={styles.actionRow}
                >
                  <AppSymbol name="square.and.arrow.up" size={22} color={COLORS.secondary} />
                  <Text style={styles.actionTitle}>
                    {exporting ? "Exportando…" : "Exportar bot"}
                  </Text>
                  {exporting ? <ActivityIndicator /> : null}
                </Pressable>
              </SectionCard>
              {duplicateError ? <Text style={styles.footerText}>{duplicateError}</Text> : null}
              {exportError ? <Text style={styles.footerText}>{exportError}</Text> : null}
            </View>
          ) : null}
        </View>

        {saveError ? <Text style={[styles.deleteError, styles.pageInset]}>{saveError}</Text> : null}

        {botId ? <RoutinesSection botId={botId} localOnly={isDemo} /> : null}

        <View style={styles.pageInset}>
          <View style={styles.sectionGap}>
            <SectionCard>
              <View style={styles.actionRow}>
                <Text style={styles.actionTitle}>Notificações</Text>
                <Switch
                  value={notify}
                  onValueChange={(value) => void persistNotify(value)}
                  trackColor={{ true: COLORS.green }}
                />
              </View>
            </SectionCard>
            <Text style={styles.footerText}>
              Receba um aviso quando este agente terminar ou precisar de você.
            </Text>
          </View>

          {!isDemo ? (
            <View style={styles.sectionGap}>
              <SectionCard>
                {confirmClear ? (
                  <View style={styles.deleteConfirm}>
                    <Text style={styles.deleteBody}>
                      Isso apaga as mensagens desta conversa e para o trabalho atual. O bot, o
                      computador, a memória e as rotinas ficam.
                    </Text>
                    {clearError ? <Text style={styles.deleteError}>{clearError}</Text> : null}
                    <View style={styles.deleteActions}>
                      <Pressable onPress={() => setConfirmClear(false)} disabled={clearing}>
                        <Text style={styles.cancelText}>Cancelar</Text>
                      </Pressable>
                      <Pressable onPress={() => void clearConversation()} disabled={clearing}>
                        <Text style={styles.deleteText}>
                          {clearing ? "Limpando…" : "Limpar conversa"}
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                ) : confirmDelete ? (
                  <View style={styles.deleteConfirm}>
                    <Text style={styles.deleteBody}>
                      Isso apaga {botName || name} de vez, incluindo o fio, o computador, a memória
                      e as rotinas.
                    </Text>
                    {deleteError ? <Text style={styles.deleteError}>{deleteError}</Text> : null}
                    <View style={styles.deleteActions}>
                      <Pressable onPress={() => setConfirmDelete(false)} disabled={deleting}>
                        <Text style={styles.cancelText}>Cancelar</Text>
                      </Pressable>
                      <Pressable onPress={() => void removeBot()} disabled={deleting}>
                        <Text style={styles.deleteText}>
                          {deleting ? "Apagando…" : "Apagar bot"}
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                ) : (
                  <Pressable onPress={() => setConfirmDelete(true)} style={styles.deleteRow}>
                    <Text style={styles.deleteText}>Apagar bot</Text>
                  </Pressable>
                )}
              </SectionCard>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function MemoryField({
  label,
  usage,
  value,
  saving,
  onChange,
  onSave,
}: {
  label: string;
  usage: string;
  value: string;
  saving: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <View style={styles.memoryField}>
      <View style={styles.memoryFieldHead}>
        <Text style={styles.memoryFieldLabel}>{label}</Text>
        <Text style={styles.memoryFieldUsage}>{usage}</Text>
      </View>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="Sem entradas ainda"
        placeholderTextColor={COLORS.tertiary}
        multiline
        style={styles.memoryInput}
      />
      <Pressable onPress={onSave} disabled={saving} style={styles.memorySaveRow}>
        <Text style={styles.memorySaveText}>{saving ? "Salvando…" : "Salvar"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  hero: { height: 142, alignItems: "center", justifyContent: "center" },
  pageInset: { paddingHorizontal: 24 },
  nameField: {
    minHeight: 55,
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
  footerText: {
    color: COLORS.tertiary,
    fontSize: 15,
    lineHeight: 20,
    marginTop: 9,
    marginHorizontal: 18,
  },
  sectionGap: { marginTop: 26 },
  actionRow: {
    minHeight: 62,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  actionTitle: { color: COLORS.primary, fontSize: 18, fontWeight: "600", flex: 1 },
  instructions: {
    minHeight: 112,
    color: COLORS.primary,
    fontSize: 16,
    lineHeight: 22,
    padding: 18,
    textAlignVertical: "top",
  },
  deleteConfirm: { padding: 18 },
  deleteBody: { color: COLORS.secondary, fontSize: 15, lineHeight: 21 },
  deleteError: { color: COLORS.red, marginTop: 10 },
  deleteActions: { flexDirection: "row", justifyContent: "flex-end", gap: 22, marginTop: 16 },
  cancelText: { color: COLORS.secondary, fontSize: 16 },
  deleteText: { color: COLORS.red, fontSize: 17, fontWeight: "600" },
  deleteRow: { minHeight: 56, paddingHorizontal: 18, justifyContent: "center" },
  memoryBody: { padding: 18, gap: 18 },
  memoryIntro: { color: COLORS.secondary, fontSize: 14, lineHeight: 19 },
  memoryField: { gap: 8 },
  memoryFieldHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  memoryFieldLabel: { color: COLORS.primary, fontSize: 15, fontWeight: "600" },
  memoryFieldUsage: { color: COLORS.tertiary, fontSize: 12 },
  memoryInput: {
    minHeight: 96,
    color: COLORS.primary,
    fontSize: 15,
    lineHeight: 21,
    backgroundColor: COLORS.cardRaised,
    borderRadius: 12,
    padding: 12,
    textAlignVertical: "top",
  },
  memorySaveRow: { alignSelf: "flex-end" },
  memorySaveText: { color: COLORS.blue, fontSize: 15, fontWeight: "600" },
});
