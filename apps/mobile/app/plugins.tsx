import { Image } from "expo-image";
import * as Linking from "expo-linking";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Platform,
  RefreshControl,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { type MobileCatalogItem, type MobileConnection, rpc } from "../lib/api";
import { COLORS, GlassIconButton, PrimaryButton, RADII, TEXT_SIZES } from "../lib/design-system";
import { AppSymbol, showNativeSheet } from "../lib/native";
import {
  connectionIdFromCallbackUrl,
  openPluginAuthorization,
  pluginCallbackUrl,
  waitForPluginConnection,
} from "../lib/plugin-connect";

function nativeCallbackUrl() {
  return pluginCallbackUrl((path) => Linking.createURL(path));
}

export default function Plugins() {
  const router = useRouter();
  const params = useLocalSearchParams<{ connectionId?: string }>();
  const [catalog, setCatalog] = useState<MobileCatalogItem[]>([]);
  const [connections, setConnections] = useState<MobileConnection[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const completed = useRef<string | null>(null);
  const alive = useRef(true);
  const inflightConnectionId = useRef<string | null>(null);
  /**
   * A chave do Composio é da instalação, e quem a cola é o dono — pelo celular também.
   * "env" é a chave do .env do servidor (não dá para trocar daqui); "stored" é a que foi
   * colada no app; "none" é o que fazia o aviso de "servidor sem Composio" aparecer.
   */
  const [composio, setComposio] = useState<{
    isOwner: boolean;
    source: "env" | "stored" | "none";
  } | null>(null);
  const [composioDraft, setComposioDraft] = useState("");
  const [composioEditing, setComposioEditing] = useState(false);
  const [composioPending, setComposioPending] = useState(false);

  useEffect(() => {
    void rpc<{ isDeploymentOwner?: boolean }>("me")
      .then(async (me) => {
        if (!me?.isDeploymentOwner) return { isOwner: false, source: "none" as const };
        const settings = await rpc<{ composioKeySource?: "env" | "stored" | "none" }>(
          "deployment/get",
        ).catch(() => null);
        return { isOwner: true, source: settings?.composioKeySource ?? ("none" as const) };
      })
      .then(setComposio)
      .catch(() => setComposio(null));
  }, []);

  async function saveComposioKey(next: string | null) {
    setError(null);
    setComposioPending(true);
    try {
      const settings = await rpc<{ composioKeySource: "env" | "stored" | "none" }>(
        "deployment/update",
        { composioApiKey: next },
      );
      setComposio({ isOwner: true, source: settings.composioKeySource });
      setComposioDraft("");
      setComposioEditing(false);
      setLoading(true);
      await load().finally(() => setLoading(false));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível salvar a chave");
    } finally {
      setComposioPending(false);
    }
  }

  const load = useCallback(async () => {
    const [items, rows] = await Promise.all([
      rpc<MobileCatalogItem[]>("connections/catalog", {}),
      rpc<MobileConnection[]>("connections/list", {}),
    ]);
    setCatalog(items);
    setConnections(rows);
    setError(null);
  }, []);

  useEffect(() => {
    alive.current = true;
    void load()
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Não foi possível carregar os plugins"),
      )
      .finally(() => setLoading(false));
    return () => {
      alive.current = false;
    };
  }, [load]);

  const finishConnection = useCallback(
    async (connectionId: string) => {
      if (!connectionId || completed.current === connectionId) return;
      completed.current = connectionId;
      setPending(connectionId);
      try {
        await rpc<MobileConnection>("connections/complete", { connectionId });
        if (!alive.current) return;
        await load();
      } catch (err) {
        if (!alive.current) return;
        setError(err instanceof Error ? err.message : "A conexão não ficou pronta");
      } finally {
        if (alive.current) setPending(null);
      }
    },
    [load],
  );

  useEffect(() => {
    const connectionId = params.connectionId;
    if (!connectionId) return;
    void finishConnection(connectionId);
  }, [params.connectionId, finishConnection]);

  useEffect(() => {
    const appState = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      const connectionId = inflightConnectionId.current;
      if (!connectionId) return;
      void rpc<MobileConnection>("connections/complete", { connectionId })
        .then((row) => {
          if (row.status === "connected" && alive.current) return load();
        })
        .catch(() => undefined);
    });
    return () => appState.remove();
  }, [load]);

  async function connect(item: MobileCatalogItem) {
    setError(null);
    setPending(item.slug);
    try {
      const started = await rpc<{ connectionId: string; authorizationUrl: string | null }>(
        "connections/begin",
        { provider: item.slug, displayName: item.name, redirectUrl: nativeCallbackUrl() },
      );
      inflightConnectionId.current = started.connectionId;
      const poll = waitForPluginConnection({
        connectionId: started.connectionId,
        hasAuthorizationUrl: Boolean(started.authorizationUrl),
        cancelled: () => !alive.current,
        complete: (connectionId) => rpc<MobileConnection>("connections/complete", { connectionId }),
      });
      if (started.authorizationUrl) {
        const returned = await openPluginAuthorization({
          authorizationUrl: started.authorizationUrl,
          redirectUrl: nativeCallbackUrl(),
          openAuthSession:
            Platform.OS === "web"
              ? undefined
              : (url, redirectUrl) => WebBrowser.openAuthSessionAsync(url, redirectUrl),
          openUrl: (url) => Linking.openURL(url),
        });
        const returnedId = returned ? connectionIdFromCallbackUrl(returned) : null;
        if (returnedId) {
          const row = await rpc<MobileConnection>("connections/complete", {
            connectionId: returnedId,
          }).catch(() => undefined);
          if (row?.status === "connected") {
            if (alive.current) await load();
            return;
          }
        }
      }
      const result = await poll;
      if (!alive.current) return;
      if (result === "cancelled") return;
      if (result !== "connected") {
        throw new Error("A conexão ainda não foi concluída. Termine o login e volte ao app.");
      }
      await load();
    } catch (err) {
      if (alive.current) {
        setError(err instanceof Error ? err.message : "Não foi possível conectar");
      }
    } finally {
      inflightConnectionId.current = null;
      if (alive.current) setPending(null);
    }
  }

  function confirmRevoke(item: MobileCatalogItem) {
    const row = connections.find(
      (entry) => entry.provider === item.slug && entry.status === "connected",
    );
    if (!row) {
      setError(`Nenhuma conexão ativa de ${item.name} neste aparelho.`);
      return;
    }
    showNativeSheet({
      title: `Desconectar ${item.name}`,
      message: "Seus bots param de usar esse app. Dá pra conectar de novo depois.",
      actions: [
        {
          label: "Desconectar",
          destructive: true,
          onPress: () => {
            setError(null);
            setPending(item.slug);
            void rpc("connections/revoke", { connectionId: row.id })
              .then(() => load())
              .catch((err: unknown) =>
                setError(err instanceof Error ? err.message : "Não foi possível desconectar"),
              )
              .finally(() => setPending(null));
          },
        },
      ],
    });
  }

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? catalog.filter(
        (item) =>
          item.name.toLowerCase().includes(needle) || item.slug.toLowerCase().includes(needle),
      )
    : catalog;
  const connectedCount = connections.filter((row) => row.status === "connected").length;
  const renderPlugin = ({ item }: { item: MobileCatalogItem }) => {
    const rowId = connections.find((row) => row.provider === item.slug)?.id;
    const busy = pending === item.slug || pending === rowId;
    return (
      <View style={styles.row}>
        {item.logo ? (
          <Image
            cachePolicy="memory-disk"
            contentFit="cover"
            source={{ uri: item.logo }}
            style={styles.logo}
            transition={120}
          />
        ) : (
          <View style={styles.logoFallback}>
            <Text style={styles.logoLetter}>{item.name.slice(0, 1).toUpperCase()}</Text>
          </View>
        )}
        <View style={styles.rowBody}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {item.connected ? "Conectado" : item.noAuth ? "Sem login" : item.slug}
          </Text>
        </View>
        {busy ? (
          <ActivityIndicator color={COLORS.secondary} />
        ) : (
          <Switch
            value={item.connected}
            accessibilityLabel={`${item.connected ? "Desconectar" : "Conectar"} ${item.name}`}
            onValueChange={(next) => (next ? void connect(item) : confirmRevoke(item))}
            trackColor={{ true: COLORS.green }}
          />
        )}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.page} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <GlassIconButton symbol="xmark" label="Fechar plugins" onPress={() => router.back()} />
          <AppSymbol name="puzzlepiece.extension.fill" size={22} color={COLORS.secondary} />
        </View>
        <Text style={styles.title}>Plugins</Text>
        <Text style={styles.subtitle}>
          {loading
            ? "Carregando catálogo…"
            : catalog.length === 0
              ? "Nenhum app disponível neste servidor."
              : `${catalog.length} apps · ${connectedCount} conectado${connectedCount === 1 ? "" : "s"}`}
        </Text>
        {catalog.length > 0 ? (
          <View style={styles.search}>
            <AppSymbol name="magnifyingglass" size={16} color={COLORS.secondary} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Buscar apps"
              placeholderTextColor={COLORS.tertiary}
              autoCorrect={false}
              autoCapitalize="none"
              style={styles.searchInput}
            />
          </View>
        ) : null}
      </View>

      <FlatList
        data={visible}
        keyExtractor={(item) => item.slug}
        renderItem={renderPlugin}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={COLORS.secondary}
            onRefresh={() => {
              setRefreshing(true);
              void load()
                .catch((err: unknown) =>
                  setError(
                    err instanceof Error ? err.message : "Não foi possível atualizar os plugins",
                  ),
                )
                .finally(() => setRefreshing(false));
            }}
          />
        }
        ListHeaderComponent={
          <>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            {loading ? <ActivityIndicator color={COLORS.secondary} /> : null}
            {!loading && catalog.length === 0 && !composio?.isOwner ? (
              <Text style={styles.empty}>
                Este servidor não tem o Composio configurado, então não há apps para conectar. Seus
                bots seguem com computador, memória e rotinas.
              </Text>
            ) : null}
            {composio?.isOwner && (catalog.length === 0 || composioEditing) ? (
              <View style={styles.composioCard}>
                <Text style={styles.composioTitle}>
                  {composio.source === "none" ? "Ligar os plugins" : "Chave do Composio"}
                </Text>
                <Text style={styles.composioText}>
                  {composio.source === "env"
                    ? "A chave do Composio veio do .env deste servidor; para trocar, edite lá."
                    : "Os apps (Gmail, Notion, Slack…) chegam pelo Composio. Crie uma chave em composio.dev e cole aqui — ela fica guardada só neste servidor."}
                </Text>
                {composio.source !== "env" ? (
                  <>
                    <TextInput
                      value={composioDraft}
                      onChangeText={setComposioDraft}
                      placeholder="Chave de API do Composio"
                      placeholderTextColor={COLORS.tertiary}
                      autoCorrect={false}
                      autoCapitalize="none"
                      secureTextEntry
                      accessibilityLabel="Chave de API do Composio"
                      style={styles.composioInput}
                    />
                    <PrimaryButton
                      label={composio.source === "stored" ? "Trocar chave" : "Salvar chave"}
                      disabled={!composioDraft.trim()}
                      pending={composioPending}
                      onPress={() => void saveComposioKey(composioDraft.trim())}
                    />
                    {composio.source === "stored" ? (
                      <Text
                        accessibilityRole="button"
                        onPress={() => void saveComposioKey(null)}
                        style={styles.composioRemove}
                      >
                        Remover a chave guardada
                      </Text>
                    ) : null}
                  </>
                ) : null}
              </View>
            ) : null}
            {composio?.isOwner && catalog.length > 0 && !composioEditing ? (
              <Text
                accessibilityRole="button"
                onPress={() => setComposioEditing(true)}
                style={styles.composioLink}
              >
                {composio.source === "env"
                  ? "Chave do Composio: .env do servidor"
                  : "Trocar a chave do Composio"}
              </Text>
            ) : null}
          </>
        }
        ListFooterComponent={
          catalog.length > 0 ? (
            <View style={styles.footer}>
              <AppSymbol name="arrow.up.right.square" size={16} color={COLORS.secondary} />
              <Text style={styles.footerText}>
                Conectar abre o login do app neste aparelho e volta direto para cá.
              </Text>
            </View>
          ) : null
        }
        initialNumToRender={12}
        maxToRenderPerBatch={10}
        windowSize={7}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: COLORS.background },
  header: { paddingHorizontal: 16, paddingTop: 8 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: {
    color: COLORS.primary,
    fontSize: 32,
    fontWeight: "600",
    marginTop: 16,
  },
  subtitle: {
    color: COLORS.secondary,
    fontSize: TEXT_SIZES.lg,
    marginTop: 4,
  },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: COLORS.card,
    borderRadius: RADII.sm,
    paddingHorizontal: 12,
    height: 44,
    marginTop: 16,
  },
  searchInput: { flex: 1, color: COLORS.primary, fontSize: 17 },
  list: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 40 },
  composioCard: {
    backgroundColor: COLORS.card,
    borderRadius: RADII.lg,
    padding: 16,
    gap: 12,
    marginBottom: 12,
  },
  composioTitle: { color: COLORS.primary, fontSize: 17, fontWeight: "600" },
  composioText: { color: COLORS.secondary, fontSize: 14, lineHeight: 20 },
  composioInput: {
    backgroundColor: COLORS.background,
    borderRadius: RADII.sm,
    paddingHorizontal: 12,
    height: 44,
    color: COLORS.primary,
    fontSize: 16,
  },
  composioRemove: { color: COLORS.red, fontSize: 14, textAlign: "center", paddingVertical: 6 },
  composioLink: { color: COLORS.blue, fontSize: 14, marginBottom: 12 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: COLORS.card,
    borderRadius: RADII.lg,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 10,
  },
  logo: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: COLORS.cardRaised,
  },
  logoFallback: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: COLORS.cardRaised,
    alignItems: "center",
    justifyContent: "center",
  },
  logoLetter: { color: COLORS.primary, fontSize: 17, fontWeight: "600" },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: { color: COLORS.primary, fontSize: 17 },
  rowMeta: { color: COLORS.secondary, fontSize: TEXT_SIZES.sm },
  error: { color: COLORS.red, fontSize: TEXT_SIZES.lg, marginBottom: 12 },
  empty: { color: COLORS.secondary, fontSize: TEXT_SIZES.lg, lineHeight: 21 },
  footer: {
    marginTop: 8,
    borderRadius: RADII.lg,
    backgroundColor: COLORS.card,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  footerText: { color: COLORS.secondary, fontSize: TEXT_SIZES.sm, flex: 1 },
});
