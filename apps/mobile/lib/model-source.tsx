import {
  chooseMode,
  chooseProvider,
  localModelUrl,
  providersForMode,
  startPolling,
  type TokenSource,
} from "@quibt/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { rpc } from "./api";
import { COLORS, PrimaryButton, SecondaryButton } from "./design-system";
import {
  currentSourceLabel,
  deviceSignInOptions,
  type ModelCatalogEntry,
  type ModelCredential,
  modelSourceBody,
  planSwitchDone,
  planSwitchLabel,
  type SignInOption,
  usingOwnCredential,
} from "./model-source-core";
import { type Edition, resolveEdition } from "./onboarding-flow";
import { SelectField } from "./select-sheet";

/**
 * Uma linha para a Conta: "OpenRouter · DeepSeek V3" (ou "Nenhuma chave ainda").
 * Lê o que o servidor já tem; não abre fluxo nenhum.
 */
export async function currentModelSummary(): Promise<string> {
  const [creds, me] = await Promise.all([
    rpc<ModelCredential[]>("models/credentials"),
    rpc<{ defaultProvider?: string; defaultModel?: string }>("me").catch(() => null),
  ]);
  const label = creds.find((cred) => cred.isDefault)?.label;
  const model = me?.defaultModel?.split("/").pop();
  if (label && model) return `${label} · ${model}`;
  return label ?? currentSourceLabel(creds);
}

type OAuthFlow =
  | { state: "idle" }
  | { state: "waiting"; loginId: string; userCode: string; verificationUri: string }
  | { state: "connected"; label: string }
  | { state: "error"; error: string };

/**
 * The "Modelos e tokens" card in Conta: OpenRouter key, local URL, device-code
 * subscriptions and switching back to the deploy key. Mirrors the web Account section.
 */
export function ModelSourceSection() {
  const [credentials, setCredentials] = useState<ModelCredential[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [options, setOptions] = useState<SignInOption[]>([]);
  const [flow, setFlow] = useState<OAuthFlow>({ state: "idle" });
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [edition, setEdition] = useState<Edition>("oss");
  const [tokenSource, setTokenSource] = useState<TokenSource>("key");
  const [provider, setProvider] = useState("openrouter");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");

  const load = useCallback(async () => {
    try {
      const [creds, models, health, me] = await Promise.all([
        rpc<ModelCredential[]>("models/credentials"),
        rpc<ModelCatalogEntry[]>("models/list"),
        rpc<{ edition?: "oss" | "cloud" }>("health").catch(() => null),
        rpc<{ defaultProvider?: string; defaultModel?: string }>("me").catch(() => null),
      ]);
      setCredentials(creds);
      setCatalog(models);
      setOptions(deviceSignInOptions(models));
      setEdition(resolveEdition({ health }));
      // Abre no modelo que os bots já usam, não no primeiro da lista.
      const preferred =
        models.find(
          (entry) => entry.provider === me?.defaultProvider && entry.id === me?.defaultModel,
        ) ??
        models.find((entry) => entry.provider === "openrouter") ??
        models[0];
      if (preferred) {
        setProvider(preferred.provider);
        setModelId(preferred.id);
      }
      setFlow((current) => (current.state === "error" ? { state: "idle" } : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível carregar os modelos");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (flow.state !== "waiting") return;
    const loginId = flow.loginId;
    return startPolling(
      async () => {
        const result = await rpc<
          | { status: "pending" }
          | { status: "connected"; credential: ModelCredential }
          | { status: "error"; error: string }
        >("models/completeOAuth", { loginId });
        if (result.status === "connected") {
          setFlow({ state: "connected", label: result.credential.label });
          setNotice(`Conectado como ${result.credential.label}.`);
          void load();
        } else if (result.status === "error") {
          setFlow({ state: "error", error: result.error });
        }
      },
      3000,
      {
        onError: (err) =>
          setFlow({
            state: "error",
            error: err instanceof Error ? err.message : "Não foi possível concluir o login",
          }),
      },
    );
  }, [flow, load]);

  const providers = useMemo(() => {
    const seen = new Map<string, ModelCatalogEntry>();
    for (const entry of catalog) {
      if (!seen.has(entry.provider)) seen.set(entry.provider, entry);
    }
    return providersForMode([...seen.values()], tokenSource);
  }, [catalog, tokenSource]);

  const modelsForProvider = useMemo(
    () => catalog.filter((entry) => entry.provider === provider),
    [catalog, provider],
  );

  const providerOptions = useMemo(
    () =>
      providers.map((entry) => ({
        id: entry.provider,
        label: entry.providerName ?? entry.provider,
      })),
    [providers],
  );

  // O id é a segunda linha: com o OpenRouter, "Gemini 3 Pro" e o `google/gemini-3-pro` que
  // se cola na configuração são coisas diferentes, e quem procura sabe uma ou a outra.
  const modelOptions = useMemo(
    () =>
      modelsForProvider.map((entry) => ({
        id: entry.id,
        label: entry.label ?? entry.id,
        hint: entry.id,
      })),
    [modelsForProvider],
  );

  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];

  function pickTokenSource(next: TokenSource) {
    setTokenSource(next);
    setError(null);
    const fixed = chooseMode({ provider, modelId, apiKey }, catalog, next);
    setProvider(fixed.provider);
    setModelId(fixed.modelId);
    setApiKey(next === "local" && !fixed.apiKey ? localModelUrl(fixed.provider) : fixed.apiKey);
  }

  function pickProvider(nextProvider: string) {
    const next = chooseProvider({ provider, modelId, apiKey }, catalog, nextProvider);
    setProvider(next.provider);
    setModelId(next.modelId);
    setApiKey(next.apiKey);
  }

  async function connectKey() {
    if (!apiKey.trim() || !selected) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await rpc("models/connect", {
        provider,
        apiKey,
        modelId: selected.id,
        label: selected.providerName ?? provider,
      });
      await rpc("models/setDefault", { provider, modelId: selected.id });
      await load();
      setNotice("Modelo conectado e definido como padrão.");
      setApiKey("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível conectar o modelo");
    } finally {
      setBusy(false);
    }
  }

  async function startSignIn(option: SignInOption) {
    setNotice(null);
    setError(null);
    setBusy(true);
    try {
      const begun = await rpc<{
        loginId: string;
        userCode: string;
        verificationUri: string;
      }>("models/beginOAuth", {
        provider: option.provider,
        modelId: option.id,
        label: option.label,
      });
      setFlow({
        state: "waiting",
        loginId: begun.loginId,
        userCode: begun.userCode,
        verificationUri: begun.verificationUri,
      });
    } catch (err) {
      setFlow({
        state: "error",
        error: err instanceof Error ? err.message : "Não foi possível iniciar o login",
      });
    } finally {
      setBusy(false);
    }
  }

  async function switchToPlanTokens() {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await rpc("models/usePlan");
      await load();
      setNotice(planSwitchDone(edition));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível trocar");
    } finally {
      setBusy(false);
    }
  }

  const own = usingOwnCredential(credentials);

  return (
    <View>
      <View style={ui.current}>
        <View style={ui.currentDot} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={ui.currentLabel}>Em uso</Text>
          <Text style={ui.currentValue} numberOfLines={1}>
            {currentSourceLabel(credentials, edition)}
          </Text>
        </View>
      </View>
      <Text style={ui.body}>{modelSourceBody(own, edition)}</Text>

      <View style={ui.segment}>
        <ModeChip
          label="Chave"
          selected={tokenSource === "key"}
          onPress={() => pickTokenSource("key")}
        />
        <ModeChip
          label="Local"
          selected={tokenSource === "local"}
          onPress={() => pickTokenSource("local")}
        />
        <ModeChip
          label="Assinatura"
          selected={tokenSource === "subscription"}
          onPress={() => pickTokenSource("subscription")}
        />
      </View>

      {tokenSource !== "subscription" ? (
        <>
          <SelectField
            label="Provedor"
            value={provider}
            options={providerOptions}
            onChange={pickProvider}
            searchPlaceholder="Buscar provedor"
          />
          <SelectField
            label="Modelo"
            value={selected?.id ?? modelId}
            options={modelOptions}
            onChange={setModelId}
            searchPlaceholder="Buscar modelo"
          />
          <Text style={ui.fieldLabel}>
            {tokenSource === "local" ? "URL do modelo" : "Chave de API"}
          </Text>
          <TextInput
            value={apiKey}
            onChangeText={setApiKey}
            placeholder={tokenSource === "local" ? localModelUrl(provider) : "sk-…"}
            placeholderTextColor={COLORS.tertiary}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry={tokenSource !== "local"}
            style={ui.input}
          />
          <PrimaryButton
            label={
              busy ? "Conectando…" : tokenSource === "local" ? "Usar este modelo" : "Salvar chave"
            }
            disabled={busy || !apiKey.trim()}
            pending={busy}
            onPress={() => void connectKey()}
            style={{ marginTop: 14 }}
          />
        </>
      ) : null}

      {flow.state === "waiting" ? (
        <View
          style={{
            marginTop: 12,
            backgroundColor: COLORS.cardRaised,
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 12,
          }}
        >
          <Pressable
            onPress={() =>
              void Linking.openURL(flow.verificationUri).catch((err: unknown) =>
                setFlow({
                  state: "error",
                  error: err instanceof Error ? err.message : "Não foi possível abrir o login",
                }),
              )
            }
          >
            <Text style={{ color: COLORS.blue, fontSize: 15 }}>{flow.verificationUri}</Text>
          </Pressable>
          <Text
            style={{
              color: COLORS.primary,
              fontSize: 22,
              letterSpacing: 4,
              marginTop: 8,
              fontVariant: ["tabular-nums"],
            }}
          >
            {flow.userCode}
          </Text>
          <Text style={{ color: COLORS.secondary, fontSize: 13, marginTop: 6 }}>
            Abra o link, digite o código e volte aqui. Esta tela atualiza sozinha.
          </Text>
        </View>
      ) : null}
      {flow.state === "connected" ? (
        <Text style={{ color: COLORS.green, marginTop: 10 }}>Conectado como {flow.label}.</Text>
      ) : null}
      {flow.state === "error" ? (
        <Text style={{ color: COLORS.red, marginTop: 10 }}>{flow.error}</Text>
      ) : null}
      {error ? <Text style={{ color: COLORS.red, marginTop: 10 }}>{error}</Text> : null}
      {notice ? <Text style={{ color: COLORS.green, marginTop: 10 }}>{notice}</Text> : null}

      {tokenSource === "subscription" ? (
        <View style={{ marginTop: 4, gap: 10 }}>
          {options.map((option) => (
            <SecondaryButton
              key={option.provider}
              label={option.label}
              disabled={busy}
              onPress={() => void startSignIn(option)}
            />
          ))}
        </View>
      ) : null}
      {own ? (
        <Pressable
          disabled={busy}
          onPress={() => void switchToPlanTokens()}
          style={{ marginTop: 18, alignItems: "center" }}
        >
          <Text style={{ color: COLORS.secondary, fontSize: 14 }}>
            {busy ? "Trocando…" : planSwitchLabel(edition)}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const ui = StyleSheet.create({
  current: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: COLORS.card,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  currentDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.green },
  currentLabel: { color: COLORS.tertiary, fontSize: 12, fontWeight: "700", letterSpacing: 0.5 },
  currentValue: { color: COLORS.primary, fontSize: 16, fontWeight: "600", marginTop: 1 },
  body: {
    color: COLORS.secondary,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 12,
    marginHorizontal: 4,
  },
  segment: {
    flexDirection: "row",
    marginTop: 16,
    padding: 3,
    borderRadius: 12,
    backgroundColor: COLORS.card,
    gap: 2,
  },
  fieldLabel: {
    color: COLORS.secondary,
    fontSize: 13,
    fontWeight: "600",
    marginTop: 14,
    marginLeft: 4,
  },
  input: {
    marginTop: 6,
    minHeight: 50,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.separator,
    backgroundColor: COLORS.background,
    color: COLORS.primary,
    paddingHorizontal: 14,
    fontSize: 16,
  },
});

function ModeChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        flex: 1,
        borderRadius: 10,
        backgroundColor: selected ? COLORS.background : "transparent",
        paddingVertical: 9,
        alignItems: "center",
      }}
    >
      <Text
        style={{
          color: selected ? COLORS.primary : COLORS.secondary,
          fontSize: 14,
          fontWeight: selected ? "700" : "500",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
