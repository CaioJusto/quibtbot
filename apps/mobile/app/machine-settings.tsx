import {
  chosenMachineMatches,
  machineCredentialsReady,
  machineGuideFor,
  machineNotice,
} from "@quibt/core";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { rpc } from "../lib/api";
import { BRAND_BLUE, BRAND_BLUE_SOFT, QuibtComputerArt } from "../lib/brand";
import { COLORS, GlassIconButton } from "../lib/design-system";
import { machineActivationGate, splitMachineCatalog } from "../lib/machine-settings";

type CatalogItem = {
  kind: string;
  family: string;
  title: string;
  body: string;
  category: string;
  needsKey: boolean;
  needsEndpoint: boolean;
  keyLabel?: string;
  endpointLabel?: string;
  ready: boolean;
  configured: boolean;
  recipe?: { hint: string; docsUrl?: string; installScript?: string };
};

export default function MachineSettings() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <View style={styles.topBar}>
        <GlassIconButton symbol="chevron.left" label="Voltar" onPress={() => router.back()} />
        <Text style={styles.topTitle}>Máquina dos bots</Text>
        <View style={{ width: 44 }} />
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <MachineSettingsBody />
      </ScrollView>
    </View>
  );
}

export function MachineSettingsBody({ onSaved }: { onSaved?: () => void }) {
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [selected, setSelected] = useState("docker");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [running, setRunning] = useState("docker");
  const [saved, setSaved] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [pending, setPending] = useState(false);
  const [probeMessage, setProbeMessage] = useState<string | null>(null);
  const [lastProbe, setLastProbe] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** O guia longo fica atrás de um toque: a tela abre só com o essencial. */
  const [guideOpen, setGuideOpen] = useState(false);

  useEffect(() => {
    void Promise.all([
      rpc<CatalogItem[]>("computers/catalog", {}).catch(() => []),
      rpc<{ sandboxProvider?: string | null; sandboxEndpoint?: string | null }>(
        "deployment/get",
      ).catch(() => null),
      rpc<{ isDeploymentOwner?: boolean; sandboxProvider?: string | null }>("me").catch(() => null),
      rpc<{ sandbox?: string }>("health").catch(() => null),
    ]).then(([items, deployment, me, health]) => {
      setCatalog(items ?? []);
      const chosen = deployment?.sandboxProvider ?? items[0]?.kind ?? "docker";
      setSelected(chosen);
      setActive(deployment?.sandboxProvider ?? me?.sandboxProvider ?? null);
      setSaved(deployment?.sandboxProvider ?? null);
      setRunning(health?.sandbox ?? deployment?.sandboxProvider ?? "docker");
      setEndpoint(deployment?.sandboxEndpoint ?? "");
      setIsOwner(Boolean(me?.isDeploymentOwner));
    });
  }, []);

  const { cards, recipes } = useMemo(() => splitMachineCatalog(catalog), [catalog]);
  const item = catalog.find((entry) => entry.kind === selected);
  const notice = machineNotice({ chosen: selected, running, saved });

  async function probe() {
    const ready = machineCredentialsReady(item, { endpoint, apiKey });
    if (!ready.ok) {
      setError(ready.message);
      return null;
    }
    setPending(true);
    setError(null);
    try {
      const result = await rpc<{ ok: boolean; message: string }>("computers/probe", {
        kind: selected,
        endpoint: endpoint.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
      });
      setLastProbe(result);
      setProbeMessage(result.message);
      if (!result.ok) setError(result.message);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Não foi possível testar a máquina";
      setError(message);
      setLastProbe({ ok: false, message });
      return { ok: false, message };
    } finally {
      setPending(false);
    }
  }

  async function save() {
    const ready = machineCredentialsReady(item, { endpoint, apiKey });
    const gate = machineActivationGate({
      credentialsReady: ready.ok,
      credentialsMessage: ready.ok ? undefined : ready.message,
      probe: lastProbe,
    });
    if (!gate.ok) {
      if (gate.action === "probe") {
        const result = await probe();
        if (!result?.ok) return;
      } else {
        setError(gate.message);
        return;
      }
    }
    setPending(true);
    setError(null);
    try {
      const settings = await rpc<{ sandboxProvider: string }>("computers/activate", {
        kind: selected,
        endpoint: endpoint.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
      });
      setSaved(settings.sandboxProvider);
      setActive(settings.sandboxProvider);
      setApiKey("");
      setLastProbe(null);
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível salvar a máquina");
    } finally {
      setPending(false);
    }
  }

  const vpsRecipes = recipes.filter((entry) => entry.family === "remote-supervisor");

  // Enxuto como o onboarding: mascote, uma frase, as opções — e o resto só quando pedirem.
  return (
    <View>
      <View style={styles.artwork}>
        <QuibtComputerArt width={150} />
      </View>
      <Text style={styles.heroTitle}>Onde seus bots trabalham</Text>
      <Text style={styles.heroSubtitle}>
        Escolha a máquina. Dá para trocar depois{active ? ` — em uso: ${active}` : ""}.
      </Text>
      {isOwner ? null : (
        <Text style={styles.ownerNote}>
          O computador dos bots foi escolhido por quem instalou o Quibt aqui. Você usa o mesmo, e
          não precisa configurar nada.
        </Text>
      )}
      <View style={styles.planList}>
        {cards.map((entry) => {
          const activeCard = entry.kind === selected;
          return (
            <Pressable
              key={entry.kind}
              accessibilityRole="button"
              accessibilityState={{ selected: activeCard }}
              onPress={() => {
                setSelected(entry.kind);
                setLastProbe(null);
                setProbeMessage(null);
                setError(null);
                setGuideOpen(false);
              }}
              style={[styles.planCard, activeCard && styles.planCardSelected]}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.planName}>{entry.title}</Text>
                {/* Uma linha por opção; a história completa mora no passo a passo. */}
                <Text numberOfLines={activeCard ? undefined : 1} style={styles.planHighlight}>
                  {entry.body}
                </Text>
              </View>
              <View style={[styles.planRadio, activeCard && styles.planRadioOn]}>
                {activeCard ? <View style={styles.planRadioDot} /> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
      {item?.needsEndpoint ? (
        <TextInput
          value={endpoint}
          onChangeText={setEndpoint}
          placeholder={item.endpointLabel ?? "URL do supervisor"}
          placeholderTextColor={COLORS.tertiary}
          autoCapitalize="none"
          style={styles.input}
        />
      ) : null}
      {item?.needsKey ? (
        <TextInput
          value={apiKey}
          onChangeText={setApiKey}
          placeholder={item.keyLabel ?? "Chave da sua conta"}
          placeholderTextColor={COLORS.tertiary}
          autoCapitalize="none"
          secureTextEntry
          style={styles.input}
        />
      ) : null}
      {vpsRecipes.length && item?.family === "remote-supervisor" ? (
        <View style={styles.recipeCard}>
          <Text style={styles.recipeHint}>
            Ainda não tem supervisor? Escolha uma receita, rode no seu provedor, depois cole a URL e
            o token.
          </Text>
          <View style={styles.recipeRow}>
            {vpsRecipes.map((recipe) => (
              <Pressable
                key={recipe.kind}
                onPress={() => {
                  setSelected(recipe.kind);
                  setLastProbe(null);
                  setProbeMessage(null);
                }}
                style={[styles.recipeChip, selected === recipe.kind && styles.recipeChipActive]}
              >
                <Text
                  style={[
                    styles.recipeChipText,
                    selected === recipe.kind && styles.recipeChipTextActive,
                  ]}
                >
                  {recipe.title}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
      {item?.recipe ? (
        <View style={styles.recipeCard}>
          <Text style={styles.recipeHint}>{item.recipe.hint}</Text>
          {item.recipe.docsUrl ? (
            <Pressable onPress={() => void Linking.openURL(item.recipe?.docsUrl ?? "")}>
              <Text style={styles.guideLink}>Documentação do provedor</Text>
            </Pressable>
          ) : null}
          {item.recipe.installScript ? (
            <Text style={styles.installScript}>{item.recipe.installScript}</Text>
          ) : null}
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: guideOpen }}
        onPress={() => setGuideOpen((value) => !value)}
        style={styles.guideToggle}
      >
        <Text style={styles.guideToggleText}>
          {guideOpen ? "Esconder o passo a passo" : "Como funciona, passo a passo"}
        </Text>
      </Pressable>
      {guideOpen ? <MachineGuideCard kind={selected} /> : null}
      {probeMessage ? <Text style={styles.probeMessage}>{probeMessage}</Text> : null}
      {notice ? (
        <Text
          style={[
            styles.notice,
            notice.tone === "ok" && styles.noticeOk,
            notice.tone === "warn" && styles.noticeWarn,
          ]}
        >
          {notice.text}
        </Text>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {isOwner ? (
        <View style={styles.actions}>
          <Pressable
            disabled={pending}
            onPress={() => void save()}
            style={[styles.primaryButton, pending && styles.disabled]}
          >
            {pending ? (
              <ActivityIndicator color={COLORS.background} />
            ) : (
              <Text style={styles.primaryText}>
                {chosenMachineMatches(saved, selected) ? "Salvar" : "Usar esta máquina"}
              </Text>
            )}
          </Pressable>
          <Pressable
            disabled={pending}
            onPress={() => void probe()}
            style={[styles.secondaryButton, pending && styles.disabled]}
          >
            <Text style={styles.secondaryText}>Testar</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function MachineGuideCard({ kind }: { kind: string }) {
  const guide = machineGuideFor(kind);
  return (
    <View style={styles.guideCard} accessibilityLabel={`Como usar ${guide.title}`}>
      <Text style={styles.guideHeadline}>{guide.headline}</Text>
      <Text style={styles.guideBody}>{guide.what}</Text>
      <Text style={styles.guideSection}>O QUE VOCÊ PRECISA</Text>
      {guide.youNeed.map((line) => (
        <Text key={line} style={styles.guideItem}>
          • {line}
        </Text>
      ))}
      <Text style={styles.guideSection}>O QUE FAZER AGORA</Text>
      {guide.steps.map((line, index) => (
        <Text key={line} style={styles.guideItem}>
          {index + 1}. {line}
        </Text>
      ))}
      <Text style={styles.guideBody}>
        <Text style={styles.guideLabel}>Vários bots. </Text>
        {guide.botsShare}
      </Text>
      <Text style={styles.guideBody}>
        <Text style={styles.guideLabel}>Custo. </Text>
        {guide.cost}
      </Text>
      {guide.signupUrl ? (
        <Pressable onPress={() => void Linking.openURL(guide.signupUrl ?? "")}>
          <Text style={styles.guideLink}>{guide.signupLabel ?? "Abrir o site"}</Text>
        </Pressable>
      ) : null}
      {guide.keyUrl ? (
        <Pressable onPress={() => void Linking.openURL(guide.keyUrl ?? "")}>
          <Text style={styles.guideLink}>{guide.keyLabel ?? "Abrir as chaves"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.rail },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    minHeight: 48,
  },
  topTitle: { color: COLORS.primary, fontSize: 17, fontWeight: "700" },
  content: { paddingHorizontal: 20, paddingTop: 8 },
  artwork: { alignItems: "center", marginBottom: 10 },
  heroTitle: {
    color: COLORS.primary,
    fontSize: 27,
    lineHeight: 32,
    fontWeight: "600",
    letterSpacing: -0.8,
    textAlign: "center",
  },
  heroSubtitle: {
    color: COLORS.secondary,
    fontSize: 15,
    lineHeight: 21,
    marginTop: 8,
    marginBottom: 18,
    textAlign: "center",
  },
  activeBadge: {
    color: COLORS.secondary,
    fontSize: 13,
    marginBottom: 12,
  },
  ownerNote: {
    color: COLORS.secondary,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 14,
    padding: 12,
    borderRadius: 12,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.separator,
  },
  planList: { gap: 10 },
  planRadio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: COLORS.separator,
    alignItems: "center",
    justifyContent: "center",
  },
  planRadioOn: { borderColor: BRAND_BLUE },
  planRadioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: BRAND_BLUE },
  guideToggle: { paddingVertical: 14, alignItems: "center" },
  guideToggleText: { color: BRAND_BLUE, fontSize: 15, fontWeight: "600" },
  planCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.separator,
    backgroundColor: COLORS.card,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  planCardSelected: {
    borderColor: BRAND_BLUE,
    backgroundColor: BRAND_BLUE_SOFT,
  },
  planName: { color: COLORS.primary, fontSize: 17, fontWeight: "600" },
  planHighlight: { color: COLORS.secondary, fontSize: 13, lineHeight: 18, marginTop: 12 },
  input: {
    minHeight: 54,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.separator,
    backgroundColor: COLORS.background,
    color: COLORS.primary,
    paddingHorizontal: 16,
    fontSize: 16,
    marginTop: 12,
  },
  recipeCard: {
    marginTop: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.separator,
    backgroundColor: COLORS.card,
    padding: 14,
    gap: 8,
  },
  recipeHint: { color: COLORS.secondary, fontSize: 13, lineHeight: 18 },
  recipeRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  recipeChip: {
    borderRadius: 99,
    borderWidth: 1,
    borderColor: COLORS.separator,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  recipeChipActive: { backgroundColor: COLORS.primaryStrong, borderColor: COLORS.primaryStrong },
  recipeChipText: { color: COLORS.primary, fontSize: 12, fontWeight: "600" },
  recipeChipTextActive: { color: COLORS.background },
  installScript: {
    color: COLORS.tertiary,
    fontSize: 11,
    lineHeight: 16,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  guideCard: {
    marginTop: 18,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.separator,
    backgroundColor: COLORS.card,
    padding: 16,
    gap: 8,
  },
  guideHeadline: { color: COLORS.primary, fontSize: 16, fontWeight: "700", lineHeight: 22 },
  guideBody: { color: COLORS.secondary, fontSize: 13, lineHeight: 18 },
  guideSection: {
    color: COLORS.tertiary,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.8,
    marginTop: 6,
  },
  guideItem: { color: COLORS.secondary, fontSize: 13, lineHeight: 18 },
  guideLabel: { color: COLORS.primary, fontWeight: "700" },
  guideLink: { color: BRAND_BLUE, fontSize: 14, fontWeight: "600", marginTop: 4 },
  probeMessage: { color: COLORS.secondary, fontSize: 13, marginTop: 14 },
  notice: { color: COLORS.secondary, fontSize: 13, marginTop: 12, lineHeight: 18 },
  noticeOk: { color: COLORS.green },
  noticeWarn: { color: "#C9A227" },
  error: { color: COLORS.red, fontSize: 14, lineHeight: 20, marginTop: 12 },
  actions: { marginTop: 20, gap: 10 },
  primaryButton: {
    height: 52,
    borderRadius: 999,
    backgroundColor: COLORS.primaryStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryButton: {
    height: 48,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: COLORS.separator,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.card,
  },
  primaryText: { color: COLORS.background, fontSize: 17, fontWeight: "600" },
  secondaryText: { color: COLORS.primary, fontSize: 16, fontWeight: "600" },
  disabled: { opacity: 0.48 },
});
