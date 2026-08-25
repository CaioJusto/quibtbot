import { inboxPresence } from "@quibt/core";
import { DEFAULT_MARK_COLOR } from "@quibt/ui-tokens";
import { Image } from "expo-image";
import { Redirect, useFocusEffect, useRouter } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentMark, GroupMark } from "../lib/agent-mark";
import { isSessionExpiredError, loadSessionToken, type MobileBot, rpc } from "../lib/api";
import { BotContextMenu, type BotMenuItem } from "../lib/bot-context-menu";
import { QuibtAppIcon } from "../lib/brand";
import { inboxTimeLabel } from "../lib/chat";
import { writeClipboardText } from "../lib/clipboard";
import { ConnectionProblem, isConnectionProblem } from "../lib/connection-problem";
import { type DemoBotSettings, isDemoBotId, withInboxPlaceholders } from "../lib/demo-inbox";
import { loadDemoBotSettings, saveDemoBotSettings } from "../lib/demo-inbox-store";
import {
  COLORS,
  GlassIconButton,
  GlassSurface,
  NativeGlassMenu,
  softHaptic,
} from "../lib/design-system";
import { canPinFavorite, homeListItems, splitHomeBots } from "../lib/home-layout";
import { SWIPE_COLORS, SwipeableRow } from "../lib/inbox-swipe";
import { AppSymbol, showNativeSheet } from "../lib/native";
import { previewSnippet } from "../lib/preview";
import { registerPushToken } from "../lib/push";
import {
  hasUsableStartupSession,
  INBOX_STARTUP_TIMEOUT_MS,
  type InboxStartupState,
  LOCAL_STARTUP_TIMEOUT_MS,
  runStartupTask,
  STARTUP_UNAVAILABLE_PARAM,
  shouldOpenConnectionScreen,
} from "../lib/startup";

type Group = {
  id: string;
  name: string;
  members: Array<{ id: string; name: string; color: string; shape?: string }>;
};

export default function Home() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [bots, setBots] = useState<MobileBot[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [me, setMe] = useState<{ name?: string; image?: string | null } | null>(null);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [inboxReady, setInboxReady] = useState(false);
  const [startupUnavailable, setStartupUnavailable] = useState(false);
  const [localDemoBots, setLocalDemoBots] = useState<MobileBot[]>([]);
  const [demoOverrides, setDemoOverrides] = useState<Record<string, DemoBotSettings>>({});
  const initialInboxAttempted = useRef(false);
  const pendingBotPatches = useRef(new Map<string, Partial<MobileBot>>());
  const suppressBotOpen = useRef(new Set<string>());

  const load = useCallback(
    async ({
      profile = false,
      signal,
    }: {
      profile?: boolean;
      signal?: AbortSignal;
    } = {}): Promise<InboxStartupState> => {
      setError(null);
      try {
        const [list, groupList, me] = await Promise.all([
          rpc<MobileBot[]>("bots/list", {}, { signal }),
          rpc<Group[]>("botGroups/list", {}, { signal }).catch(() => [] as Group[]),
          profile
            ? rpc<{ name?: string; image?: string | null }>("me", {}, { signal }).catch(() => null)
            : Promise.resolve(undefined),
        ]);
        const merged = list.map((bot) => ({
          ...bot,
          ...(pendingBotPatches.current.get(bot.id) ?? {}),
        }));
        // The inbox polls; only re-render the rows when something actually changed.
        setBots((current) => (sameJson(current, merged) ? current : merged));
        setGroups((current) => (sameJson(current, groupList) ? current : groupList));
        if (me !== undefined) setMe(me);
        setNeedsOnboarding(list.length === 0 && groupList.length === 0);
        setInboxReady(true);
        return "ready";
      } catch (err) {
        setError(err instanceof Error ? err.message : "Não foi possível carregar os bots");
        setInboxReady(true);
        if (isSessionExpiredError(err) || !(await loadSessionToken())) {
          setHasSession(false);
          return "signed-out";
        }
        return "unavailable";
      }
    },
    [],
  );

  useEffect(() => {
    let active = true;
    void runStartupTask(() => loadSessionToken(), LOCAL_STARTUP_TIMEOUT_MS).then((result) => {
      if (!active) return;
      setHasSession(hasUsableStartupSession(result));
      setReady(true);
    });
    return () => {
      active = false;
    };
  }, []);
  useFocusEffect(
    useCallback(() => {
      if (!hasSession) return;
      let active = true;
      void registerPushToken();
      let inFlight = false;
      const refresh = async (profile = false, startup = false) => {
        if (inFlight) return;
        inFlight = true;
        try {
          if (!startup) {
            await load({ profile });
            return;
          }
          const result = await runStartupTask(
            (signal) => load({ profile, signal }),
            INBOX_STARTUP_TIMEOUT_MS,
          );
          if (active && shouldOpenConnectionScreen(result)) {
            setStartupUnavailable(true);
          }
        } finally {
          inFlight = false;
        }
      };
      // Poll only while the app is in front; the screen stays "focused" in the background.
      let poll: ReturnType<typeof setInterval> | undefined;
      const start = () => {
        if (poll) return;
        const startup = !initialInboxAttempted.current;
        initialInboxAttempted.current = true;
        void refresh(true, startup);
        poll = setInterval(() => void refresh(), 4000);
      };
      const stop = () => {
        if (poll) clearInterval(poll);
        poll = undefined;
      };
      if (AppState.currentState !== "background") start();
      const appState = AppState.addEventListener("change", (state) => {
        if (state === "active") start();
        else if (state === "background") stop();
      });
      return () => {
        active = false;
        appState.remove();
        stop();
      };
    }, [hasSession, load]),
  );

  useFocusEffect(
    useCallback(() => {
      void loadDemoBotSettings().then(setDemoOverrides);
    }, []),
  );

  const createActions = [
    {
      label: "Novo bot",
      systemImage: "person.crop.circle.badge.plus",
      onPress: () => router.push("/new"),
    },
    {
      label: "Novo grupo",
      systemImage: "person.3.fill",
      onPress: () => router.push("/new-group"),
    },
  ];

  /**
   * A caixa de entrada se atualiza sozinha a cada 4 s. Sem memória, cada volta do poll
   * recriava estas listas e, com elas, a identidade de cada bot — o que fazia a lista
   * inteira redesenhar mesmo quando nada tinha mudado. Recalcular só quando a origem
   * muda é o que deixa a rolagem lisa e a bateria em paz.
   */
  const displayBots = useMemo(
    () =>
      withInboxPlaceholders([...bots, ...localDemoBots]).map((bot) => ({
        ...bot,
        ...(demoOverrides[bot.id] ?? {}),
      })),
    [bots, localDemoBots, demoOverrides],
  );
  const q = query.trim().toLowerCase();
  const visibleBots = useMemo(
    () =>
      q
        ? displayBots.filter((bot) =>
            `${bot.name} ${bot.title} ${bot.preview}`.toLowerCase().includes(q),
          )
        : displayBots.filter((bot) => !bot.hidden),
    [displayBots, q],
  );
  const { favorites, list: listBots } = useMemo(
    () => splitHomeBots(visibleBots, searchOpen),
    [visibleBots, searchOpen],
  );
  const visibleGroups = useMemo(
    () =>
      q
        ? groups.filter((group) =>
            `${group.name} ${group.members.map((member) => member.name).join(" ")}`
              .toLowerCase()
              .includes(q),
          )
        : groups,
    [groups, q],
  );

  const reportActionError = useCallback((err: unknown, fallback: string) => {
    const message = err instanceof Error ? err.message : fallback;
    setError(message);
    showNativeSheet({ title: "Não foi possível salvar", message, actions: [] });
  }, []);

  const applyDemoPatch = useCallback((bot: MobileBot, patch: Partial<MobileBot>) => {
    setDemoOverrides((current) => ({
      ...current,
      [bot.id]: { ...(current[bot.id] ?? {}), ...patch },
    }));
    void saveDemoBotSettings(bot.id, patch);
  }, []);

  const updateBot = useCallback(
    async (bot: MobileBot, patch: Partial<MobileBot>) => {
      setError(null);
      if (isDemoBotId(bot.id)) {
        applyDemoPatch(bot, patch);
        return;
      }

      const before = bot;
      pendingBotPatches.current.set(bot.id, {
        ...(pendingBotPatches.current.get(bot.id) ?? {}),
        ...patch,
      });
      // Só a linha tocada muda de identidade: as outras seguem iguais e o memo as poupa.
      setBots((current) =>
        current.map((candidate) =>
          candidate.id === bot.id ? { ...candidate, ...patch } : candidate,
        ),
      );
      try {
        const saved = await rpc<MobileBot>("bots/update", { botId: bot.id, ...patch });
        pendingBotPatches.current.delete(bot.id);
        setBots((current) =>
          current.map((candidate) =>
            candidate.id === bot.id ? { ...candidate, ...saved } : candidate,
          ),
        );
      } catch (err) {
        pendingBotPatches.current.delete(bot.id);
        setBots((current) =>
          current.map((candidate) => (candidate.id === bot.id ? before : candidate)),
        );
        reportActionError(err, "Não foi possível atualizar o bot");
      }
    },
    [applyDemoPatch, reportActionError],
  );

  const duplicateBot = useCallback(
    async (bot: MobileBot) => {
      setError(null);
      if (isDemoBotId(bot.id)) {
        setLocalDemoBots((current) => [
          ...current,
          {
            ...bot,
            id: `demo:copy:${Date.now()}`,
            name: `${bot.name} cópia`,
            pinned: false,
            unread: false,
            updatedAt: new Date().toISOString(),
          },
        ]);
        return;
      }
      try {
        const copy = await rpc<MobileBot>("bots/duplicate", { botId: bot.id });
        setBots((current) => [copy, ...current]);
      } catch (err) {
        reportActionError(err, "Não foi possível duplicar o bot");
      }
    },
    [reportActionError],
  );

  const openBot = useCallback(
    (bot: MobileBot) => {
      if (suppressBotOpen.current.delete(bot.id)) return;
      router.push(threadHref(bot));
    },
    [router],
  );

  const suppressNextOpen = useCallback((bot: MobileBot) => {
    suppressBotOpen.current.add(bot.id);
    setTimeout(() => suppressBotOpen.current.delete(bot.id), 900);
  }, []);

  const inboxItems = useMemo(
    () => homeListItems(listBots, visibleGroups),
    [listBots, visibleGroups],
  );
  const headerTop = insets.top + 22;
  /**
   * A barra fica fora da FlatList: perfil, busca e "+" são chrome, não conteúdo.
   * Dentro do `ListHeaderComponent` eles subiam junto com a rolagem e o usuário
   * perdia o acesso a criar bot no meio da caixa de entrada.
   */
  const topBar = (
    <View style={[styles.topBar, { paddingTop: headerTop, height: headerTop + HEADER_HEIGHT }]}>
      <View style={styles.header}>
        {searchOpen ? (
          <>
            <GlassIconButton
              symbol="xmark"
              label="Fechar busca"
              onPress={() => {
                setSearchOpen(false);
                setQuery("");
              }}
            />
            <GlassSurface clear style={styles.searchField}>
              <AppSymbol name="magnifyingglass" size={20} color={COLORS.tertiary} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Buscar"
                placeholderTextColor={COLORS.tertiary}
                autoFocus
                returnKeyType="search"
                style={styles.searchInput}
              />
            </GlassSurface>
            <GlassIconButton
              symbol="slider.horizontal.3"
              label="Filtrar"
              onPress={() => undefined}
            />
          </>
        ) : (
          <>
            <GlassSurface interactive clear style={styles.profileGlass}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Abrir conta"
                onPress={() => {
                  softHaptic();
                  router.push("/account");
                }}
                style={styles.profileButton}
              >
                {me?.image ? (
                  <Image
                    cachePolicy="memory-disk"
                    contentFit="cover"
                    source={{ uri: me.image }}
                    style={styles.profileImage}
                    transition={120}
                  />
                ) : (
                  <Text style={styles.profileInitial}>
                    {(me?.name ?? "U").slice(0, 1).toUpperCase()}
                  </Text>
                )}
              </Pressable>
            </GlassSurface>
            <View style={styles.headerActions}>
              <GlassIconButton
                symbol="magnifyingglass"
                label="Buscar"
                onPress={() => setSearchOpen(true)}
              />
              <NativeGlassMenu systemImage="plus" label="Criar" actions={createActions} />
            </View>
          </>
        )}
      </View>
    </View>
  );
  const renderInboxItem = useCallback(
    ({ item }: { item: (typeof inboxItems)[number] }) => {
      if (item.kind === "bot") {
        return (
          <BotRow
            bot={item.bot}
            canPin={canPinFavorite(displayBots, item.bot)}
            onOpen={openBot}
            onDuplicate={duplicateBot}
            onMenuOpen={suppressNextOpen}
            onUpdate={updateBot}
          />
        );
      }
      return <GroupRow group={item.group} />;
    },
    [canPinFavorite, displayBots, duplicateBot, openBot, suppressNextOpen, updateBot],
  );

  // Só depois de todos os hooks: um return antecipado aqui em cima mudava a contagem de
  // hooks entre a abertura e a caixa de entrada — o React estourava e, em Release, o app
  // fechava na hora de entrar (e de novo a cada abertura).
  if (startupUnavailable) {
    return (
      <Redirect href={{ pathname: "/welcome", params: { startup: STARTUP_UNAVAILABLE_PARAM } }} />
    );
  }
  if (!ready || (hasSession && !inboxReady)) {
    return (
      <View style={styles.loading}>
        <QuibtAppIcon size={72} />
      </View>
    );
  }
  if (!hasSession) return <Redirect href="/welcome" />;
  if (needsOnboarding) return <Redirect href="/onboarding" />;

  return (
    <View style={styles.screen}>
      <FlatList
        data={inboxItems}
        keyExtractor={(item) => item.key}
        renderItem={renderInboxItem}
        style={styles.scroll}
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{
          paddingTop: headerTop + HEADER_HEIGHT + 12,
          paddingBottom: Math.max(insets.bottom, 18) + 28,
        }}
        refreshControl={
          <RefreshControl
            progressViewOffset={headerTop + HEADER_HEIGHT}
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load({ profile: true }).finally(() => setRefreshing(false));
            }}
            tintColor={COLORS.secondary}
          />
        }
        ListHeaderComponent={
          <>
            {favorites.length > 0 ? (
              <View style={styles.featured}>
                <View
                  style={[
                    styles.featuredContent,
                    favorites.length === 3 ? styles.featuredContentThree : null,
                  ]}
                >
                  {favorites.map((bot) => (
                    <FavoriteBot
                      bot={bot}
                      canPin={canPinFavorite(displayBots, bot)}
                      key={bot.id}
                      onDuplicate={duplicateBot}
                      onMenuOpen={suppressNextOpen}
                      onOpen={openBot}
                      onUpdate={updateBot}
                      size={favorites.length === 3 ? 104 : 124}
                    />
                  ))}
                </View>
              </View>
            ) : null}
            <View style={styles.listSpacer} />
          </>
        }
        ListFooterComponent={
          error ? (
            isConnectionProblem(error) ? (
              <ConnectionProblem
                compact={bots.length > 0 || groups.length > 0}
                retrying={refreshing}
                onRetry={() => {
                  setRefreshing(true);
                  void load({ profile: true }).finally(() => setRefreshing(false));
                }}
              />
            ) : (
              <Text style={styles.error}>{error}</Text>
            )
          ) : null
        }
        initialNumToRender={12}
        maxToRenderPerBatch={10}
        windowSize={7}
        removeClippedSubviews={Platform.OS === "android"}
      />
      {topBar}
    </View>
  );
}

function sameJson(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function threadHref(bot: MobileBot) {
  return {
    pathname: "/thread" as const,
    params: {
      botId: bot.id,
      name: bot.name,
      color: bot.color ?? DEFAULT_MARK_COLOR,
      shape: bot.shape ?? "",
      demo: isDemoBotId(bot.id) ? "1" : "0",
    },
  };
}

type BotRowActions = {
  bot: MobileBot;
  canPin: boolean;
  onUpdate: (bot: MobileBot, patch: Partial<MobileBot>) => void;
  onDuplicate: (bot: MobileBot) => void;
};

/** As mesmas ações no favorito e na linha da lista, e no menu de contexto de ambos. */
function useBotMenuItems({ bot, canPin, onUpdate, onDuplicate }: BotRowActions): BotMenuItem[] {
  return useMemo(
    () => [
      {
        label: bot.unread ? "Marcar como lida" : "Marcar como não lida",
        systemImage: bot.unread ? "envelope.open" : "envelope.badge",
        onPress: () => onUpdate(bot, { unread: !bot.unread }),
      },
      {
        label: bot.pinned ? "Desafixar" : canPin ? "Fixar" : "Máximo de 3 favoritos",
        systemImage: bot.pinned ? "pin.slash" : "pin",
        disabled: !bot.pinned && !canPin,
        onPress: () => {
          if (!canPin && !bot.pinned) return;
          onUpdate(bot, { pinned: !bot.pinned });
        },
      },
      {
        label: bot.hidden ? "Mostrar na lista" : "Ocultar",
        systemImage: bot.hidden ? "eye" : "eye.slash",
        destructive: !bot.hidden,
        onPress: () => onUpdate(bot, { hidden: !bot.hidden }),
      },
      {
        // O que quase nunca se usa sai da frente, mas continua a um toque de distância.
        label: "Mais",
        systemImage: "ellipsis",
        submenu: [
          {
            label: "Duplicar",
            systemImage: "doc.on.doc",
            onPress: () => onDuplicate(bot),
          },
          {
            label: "Copiar ID da conversa",
            systemImage: "doc.on.clipboard",
            onPress: () => void writeClipboardText(bot.id),
          },
        ],
      },
    ],
    [bot, canPin, onDuplicate, onUpdate],
  );
}

/** O bot em destaque no topo: marca grande, mesmas ações no toque longo. */
const FavoriteBot = memo(function FavoriteBot({
  bot,
  canPin,
  size,
  onOpen,
  onUpdate,
  onDuplicate,
  onMenuOpen,
}: BotRowActions & {
  size: number;
  onOpen: (bot: MobileBot) => void;
  onMenuOpen: (bot: MobileBot) => void;
}) {
  const items = useBotMenuItems({ bot, canPin, onUpdate, onDuplicate });
  return (
    <BotContextMenu
      accessibilityLabel={bot.name}
      items={items}
      onMenuOpen={() => onMenuOpen(bot)}
      onPress={() => onOpen(bot)}
      style={styles.featuredBot}
    >
      <AgentMark
        color={bot.color ?? DEFAULT_MARK_COLOR}
        shape={bot.shape}
        size={size}
        presence={inboxPresence({ status: bot.status, unread: bot.unread })}
      />
      <Text numberOfLines={1} style={styles.featuredName}>
        {bot.name}
      </Text>
    </BotContextMenu>
  );
});

/**
 * A linha da caixa de entrada, memoizada: sem isto, cada volta do poll de 4 s
 * redesenhava todas as linhas — inclusive as marcas, que são SVG. Só muda quando o
 * próprio bot muda, e os callbacks vêm estáveis de cima para o memo valer.
 */
const BotRow = memo(function BotRow({
  bot,
  canPin,
  onOpen,
  onUpdate,
  onDuplicate,
  onMenuOpen,
}: {
  bot: MobileBot;
  canPin: boolean;
  onOpen: (bot: MobileBot) => void;
  onUpdate: (bot: MobileBot, patch: Partial<MobileBot>) => void;
  onDuplicate: (bot: MobileBot) => void;
  onMenuOpen: (bot: MobileBot) => void;
}) {
  const items = useBotMenuItems({ bot, canPin, onUpdate, onDuplicate });

  return (
    <SwipeableRow
      leading={{
        label: bot.unread ? "Marcar como lida" : "Marcar como não lida",
        symbol: bot.unread ? "envelope.open" : "envelope.badge",
        color: SWIPE_COLORS.unread,
        onPress: () => onUpdate(bot, { unread: !bot.unread }),
      }}
      trailing={[
        {
          label: bot.pinned ? "Desafixar" : "Fixar",
          symbol: bot.pinned ? "pin.slash" : "pin",
          color: SWIPE_COLORS.pin,
          onPress: () => {
            if (!canPin && !bot.pinned) return;
            onUpdate(bot, { pinned: !bot.pinned });
          },
        },
        {
          label: bot.hidden ? "Mostrar" : "Ocultar",
          symbol: bot.hidden ? "eye" : "eye.slash",
          color: SWIPE_COLORS.hide,
          onPress: () => onUpdate(bot, { hidden: !bot.hidden }),
        },
      ]}
    >
      <BotContextMenu
        accessibilityLabel={bot.name}
        highlight={
          <View style={styles.highlightRow}>
            <AgentMark color={bot.color ?? DEFAULT_MARK_COLOR} shape={bot.shape} size={56} />
            <Text numberOfLines={1} style={styles.highlightName}>
              {bot.name}
            </Text>
            <Text style={styles.time}>{inboxTimeLabel(bot.updatedAt) ?? ""}</Text>
          </View>
        }
        items={items}
        onMenuOpen={() => onMenuOpen(bot)}
        onPress={() => onOpen(bot)}
        style={[styles.inboxRow, styles.inboxListRow]}
      >
        <AgentMark
          color={bot.color ?? DEFAULT_MARK_COLOR}
          shape={bot.shape}
          size={56}
          presence={inboxPresence({ status: bot.status, unread: bot.unread })}
        />
        <View style={styles.rowContent}>
          <View style={styles.rowTopline}>
            <Text numberOfLines={1} style={styles.rowName}>
              {bot.name}
            </Text>
            {bot.chiefOfStaff ? <Text style={styles.chief}>♔</Text> : null}
            {bot.title ? (
              <View style={styles.tag}>
                <Text numberOfLines={1} style={styles.tagText}>
                  {bot.title}
                </Text>
              </View>
            ) : null}
            <View style={styles.rowStatus}>
              {bot.unread ? <View style={styles.unreadDot} /> : null}
              <Text style={styles.time}>{inboxTimeLabel(bot.updatedAt) ?? ""}</Text>
            </View>
          </View>
          <Text numberOfLines={1} style={styles.preview}>
            {previewSnippet(bot.preview) || " "}
          </Text>
        </View>
      </BotContextMenu>
    </SwipeableRow>
  );
});

const GroupRow = memo(function GroupRow({ group }: { group: Group }) {
  const router = useRouter();
  // Sem `Link asChild`: o Slot dele espalhava o array de estilos num objeto e a linha
  // perdia padding e direção — as marcas em cima, o nome embaixo, colado na borda.
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={group.name}
      onPress={() =>
        router.push({ pathname: "/thread", params: { groupId: group.id, name: group.name } })
      }
      style={[styles.inboxRow, styles.inboxListRow]}
    >
      <GroupMark members={group.members} size={56} />
      <View style={styles.rowContent}>
        <View style={styles.rowTopline}>
          <Text numberOfLines={1} style={styles.rowName}>
            {group.name}
          </Text>
          <View style={styles.tag}>
            <Text numberOfLines={1} style={styles.tagText}>
              Grupo
            </Text>
          </View>
        </View>
        <Text numberOfLines={1} style={styles.preview}>
          {group.members.map((member) => member.name).join(", ") || "Grupo"}
        </Text>
      </View>
    </Pressable>
  );
});

/** Altura útil da barra fixa: o controle de 44 com um respiro embaixo. */
const HEADER_HEIGHT = 46;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  scroll: { flex: 1 },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    justifyContent: "flex-start",
  },
  loading: {
    flex: 1,
    alignItems: "center",
    backgroundColor: COLORS.background,
    justifyContent: "center",
    padding: 24,
  },
  header: {
    minHeight: 46,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  /** Mesmo vidro e mesma sombra da busca e do "+": os três são um só conjunto. */
  profileGlass: { width: 44, height: 44, borderRadius: 22 },
  profileButton: {
    flex: 1,
    borderRadius: 22,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  profileImage: { width: "100%", height: "100%" },
  profileInitial: { color: COLORS.primary, fontWeight: "700", fontSize: 17 },
  searchField: {
    height: 44,
    borderRadius: 22,
    flex: 1,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  searchInput: { flex: 1, color: COLORS.primary, fontSize: 16, paddingVertical: 0 },
  featured: { marginTop: 34, paddingHorizontal: 18 },
  featuredContent: {
    minHeight: 160,
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "center",
    gap: 44,
  },
  featuredContentThree: { justifyContent: "space-between", gap: 0 },
  featuredBot: { width: 112, alignItems: "center" },
  featuredName: {
    color: COLORS.secondary,
    fontSize: 14,
    fontWeight: "600",
    marginTop: 10,
    maxWidth: 112,
  },
  listSpacer: { height: 24 },
  inboxRow: { minHeight: 84, flexDirection: "row", alignItems: "center", gap: 16 },
  /** O resumo que sobe no toque longo: marca, nome e hora, sem a prévia da conversa. */
  highlightRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  highlightName: { flex: 1, color: COLORS.primary, fontSize: 17, fontWeight: "700" },
  inboxListRow: { marginHorizontal: 18 },
  rowContent: { flex: 1, minWidth: 0 },
  rowTopline: { flexDirection: "row", alignItems: "center", gap: 7 },
  rowName: {
    color: COLORS.primary,
    fontSize: 16,
    lineHeight: 21,
    fontWeight: "600",
    flexShrink: 1,
  },
  tag: {
    backgroundColor: COLORS.tile,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
    maxWidth: 138,
  },
  tagText: { color: COLORS.secondary, fontSize: 12, lineHeight: 16, fontWeight: "600" },
  /** O dourado do chief of staff é conteúdo, não cromo — só ganhou contraste no claro. */
  chief: { color: "#A76A05", fontSize: 13 },
  rowStatus: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 6 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.blue },
  time: { color: COLORS.tertiary, fontSize: 13, lineHeight: 18 },
  preview: {
    color: COLORS.secondary,
    fontSize: 15,
    lineHeight: 20,
    marginTop: 3,
  },
  error: { color: COLORS.red, margin: 18 },
});
