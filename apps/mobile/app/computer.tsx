import { Image } from "expo-image";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { currentApiBase, rpc } from "../lib/api";
import { readClipboardText } from "../lib/clipboard";
import {
  allowScreenNavigation,
  COMPUTER_HEARTBEAT_MS,
  type ComputerStatus,
  computerFailureMessage,
  computerPollMs,
  controlLabel,
  createPointerMoveCoalescer,
  decideScreenUrl,
  embeddableScreenUrl,
  needsScreenUrlRpc,
  planScreenReconnect,
  previewPlaceholder,
  screenBridgeMessage,
  screenNotice,
  trackpadReleaseAction,
  withControlLease,
} from "../lib/computer";
import { boundedStrokes, strokesForEdit } from "../lib/computer-keyboard";
import { COLORS, GlassSurface, softHaptic } from "../lib/design-system";
import { AppSymbol, type AppSymbolName, isIOS, showNativeSheet } from "../lib/native";

/**
 * A tela do bot é a máquina de verdade, não cromo do app: ela é a única superfície escura
 * que o sistema visual permite. Estes três tons valem só dentro dela.
 */
const SCREEN_BLACK = "#000000";
const SCREEN_INK = "#F1F1F2";
const SCREEN_MUTED = "#8B8B92";
/** Controle circular escuro: sobre a tela do bot, vidro claro vira mancha branca. */
const SCREEN_CONTROL = "rgba(120, 120, 128, 0.24)";

async function loadComputerStatus(botId: string, pinnedUrl: string | null) {
  const status = await rpc<ComputerStatus>("computer/status", { botId });
  if (status.screenUrl) return { status, screenUrl: status.screenUrl };
  if (needsScreenUrlRpc({ status, pinnedUrl })) {
    const screen = await rpc<{ url: string | null }>("computer/screenUrl", { botId });
    return { status, screenUrl: screen.url };
  }
  return { status, screenUrl: null };
}

export default function Computer() {
  const navigation = useNavigation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { botId, name: nameParam } = useLocalSearchParams<{ botId?: string; name?: string }>();
  const name = nameParam || "Bot";
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const [screenUrl, setScreenUrl] = useState<string | null>(null);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [booting, setBooting] = useState(false);
  const [computerOpen, setComputerOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [trackpad, setTrackpad] = useState(false);
  /**
   * O teclado do celular escrevendo na máquina. O campo fica invisível: quem aparece é
   * o teclado do sistema, e o que a pessoa digita vira tecla lá dentro. O rascunho
   * guardado é só a régua para saber o que mudou entre uma letra e a próxima.
   */
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const keyboardInput = useRef<TextInput>(null);
  const typed = useRef("");

  async function sendTyped(next: string) {
    const strokes = boundedStrokes(strokesForEdit(typed.current, next));
    typed.current = next;
    if (!botId || !strokes.length) return;
    for (const stroke of strokes) {
      await rpc("computer/input", { botId, kind: "key", payload: { key: stroke.key } }).catch(
        () => undefined,
      );
    }
  }
  const autoBooted = useRef<string | null>(null);

  function leaveComputer() {
    setComputerOpen(false);
    setTrackpad(false);
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    if (botId) {
      router.replace({ pathname: "/thread", params: { botId, name } });
      return;
    }
    router.replace("/");
  }

  const embeddedScreenUrl = embeddableScreenUrl(screenUrl, currentApiBase());
  const hasControl = computer?.controlHolder === "user";

  // The status poll re-signs the screen URL every couple of seconds. The WebView reloads
  // whenever its URL changes, so the URL it shows is pinned while the screen is on and only
  // renewed when it is not showing or when it points at a different screen.
  const [pinnedScreenUrl, setPinnedScreenUrl] = useState<string | null>(null);
  const pinnedScreenUrlRef = useRef<string | null>(null);
  pinnedScreenUrlRef.current = pinnedScreenUrl;

  /**
   * Sem o controle não há stream (a capacidade do noVNC é interativa, só vai para quem tem
   * a posse), mas há a tela: um retrato parado a cada 4 s, atrás do botão de assumir. Quem
   * chega vê o que o bot está fazendo antes de decidir entrar.
   */
  const [preview, setPreview] = useState<string | null>(null);
  const wantsPreview =
    ready && computer?.state === "running" && !pinnedScreenUrl && !hasControl && !computerOpen;
  useEffect(() => {
    if (!wantsPreview || !botId) {
      setPreview(null);
      return;
    }
    let active = true;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await rpc<{ image: string | null }>("computer/preview", { botId });
        if (active && result.image) setPreview(result.image);
      } catch {
        // Sem prévia ainda: a frase de baixo continua dizendo o estado.
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [wantsPreview, botId]);
  const screenShownAt = useRef<number | null>(null);
  const screenLive = computer?.state === "running";

  const screenRetries = useRef(0);
  const screenRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handledScreenDrop = useRef(0);
  // Bumped once per reconnect attempt so the pin below knows the session died.
  const [screenDrop, setScreenDrop] = useState(0);
  const [screenLost, setScreenLost] = useState(false);

  useEffect(() => {
    if (!screenLive) {
      screenShownAt.current = null;
      screenRetries.current = 0;
      handledScreenDrop.current = screenDrop;
      setPinnedScreenUrl(null);
      setScreenLost(false);
      return;
    }
    // Gave up: take the frozen WebView down and stop remounting until the user asks again.
    if (screenLost) {
      screenShownAt.current = null;
      handledScreenDrop.current = screenDrop;
      setPinnedScreenUrl(null);
      return;
    }
    const now = Date.now();
    const dropped = handledScreenDrop.current !== screenDrop;
    handledScreenDrop.current = screenDrop;
    const decision = decideScreenUrl({
      current: pinnedScreenUrlRef.current,
      next: embeddedScreenUrl,
      mountedAt: screenShownAt.current,
      now,
      disconnected: dropped,
    });
    screenShownAt.current = decision.url ? (screenShownAt.current ?? now) : null;
    setPinnedScreenUrl(decision.url);
  }, [screenLive, embeddedScreenUrl, screenDrop, screenLost, pinnedScreenUrl]);

  useEffect(() => {
    return () => {
      if (screenRetryTimer.current) clearTimeout(screenRetryTimer.current);
    };
  }, []);

  // noVNC never re-handshakes on its own: a network change or a sandbox restart would leave
  // a frozen WebView. The embed page reports the drop; the 2 s status poll is already
  // minting fresh capabilities, so remounting is all that is missing.
  const onScreenMessage = (raw: unknown) => {
    const kind = screenBridgeMessage(raw);
    if (!kind) return;
    if (kind === "connected") {
      screenRetries.current = 0;
      setScreenLost(false);
      setScreenError(null);
      return;
    }
    const plan = planScreenReconnect(screenRetries.current);
    if (!plan.retry) {
      setScreenLost(true);
      setScreenError("A tela caiu e não voltou. Toque pra abrir de novo.");
      return;
    }
    screenRetries.current = plan.nextAttempt;
    if (screenRetryTimer.current) clearTimeout(screenRetryTimer.current);
    screenRetryTimer.current = setTimeout(() => {
      screenRetryTimer.current = null;
      setScreenDrop((drop) => drop + 1);
    }, plan.delayMs);
  };

  useLayoutEffect(() => {
    navigation.setOptions({ title: `${name}` });
  }, [name, navigation]);

  async function refresh(isActive: () => boolean = () => true) {
    if (!botId) return;
    const result = await loadComputerStatus(botId, pinnedScreenUrlRef.current);
    if (!isActive()) return result.status;
    setComputer(result.status);
    setScreenUrl(result.screenUrl);
    setReady(true);
    return result.status;
  }

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        if (!botId) return;
        const result = await loadComputerStatus(botId, pinnedScreenUrlRef.current);
        if (!active) return;
        setComputer(result.status);
        setScreenUrl(result.screenUrl);
        setReady(true);
      } catch (err) {
        if (!active) return;
        setError(computerFailureMessage(err, "Não foi possível atualizar o computador"));
        setReady(true);
      } finally {
        inFlight = false;
      }
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer) return;
      void poll();
      timer = setInterval(() => void poll(), computerPollMs(hasControl));
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    if (AppState.currentState !== "background") start();
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") start();
      else if (state === "background") stop();
    });
    return () => {
      active = false;
      appState.remove();
      if (timer) clearInterval(timer);
      timer = undefined;
    };
  }, [botId, hasControl]);

  async function bootComputer(
    {
      takeControl,
      overlay,
    }: {
      takeControl: boolean;
      overlay: boolean;
    },
    isActive: () => boolean = () => true,
  ) {
    if (!botId) return;
    const needsBoot = computer?.state !== "running" || !screenUrl;
    if (overlay && needsBoot && isActive()) setBooting(true);
    try {
      if (needsBoot) await rpc("computer/boot", { botId });
      if (takeControl) await rpc("computer/takeover", { botId });
      await refresh(isActive);
      if (isActive()) setError(null);
    } catch (err) {
      if (isActive()) {
        setError(computerFailureMessage(err, "Não foi possível abrir o computador"));
      }
      throw err;
    } finally {
      if (isActive()) setBooting(false);
    }
  }

  useEffect(() => {
    if (!ready || !botId) return;
    if (computer?.state === "booting" || computer?.state === "suspended") return;
    if (autoBooted.current === botId) return;
    let active = true;
    autoBooted.current = botId;
    void bootComputer(
      {
        takeControl: false,
        overlay: computer?.state !== "running",
      },
      () => active,
    ).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [ready, botId, computer?.state]);

  useEffect(() => {
    if (!botId || !hasControl || computer?.state !== "running") return;
    // Celular no bolso não é gente na frente do computador: os timers do JS seguem rodando
    // um tempo em segundo plano, e a batida segurava o teclado de um bot que já podia estar
    // trabalhando. Só bate com o app na frente — como o poll de status logo acima.
    const ping = () => {
      if (AppState.currentState === "background") return;
      // Estar nesta tela com o app à frente é, no celular, estar na frente do computador:
      // o toque na tela do bot vai direto pelo noVNC, sem passar pela nossa API. Quando o
      // aparelho bloqueia, o AppState sai de `active` e o prazo volta a correr.
      void rpc<{ controlLeaseExpiresAt?: string | null }>("computer/heartbeat", {
        botId,
        atScreen: true,
      })
        .then((answer) => {
          // O prazo novo, quando houve, mantém o "Você tem o controle até HH:mm" andando.
          setComputer((current) => withControlLease(current, answer?.controlLeaseExpiresAt));
        })
        .catch(() => undefined);
    };
    ping();
    const timer = setInterval(ping, COMPUTER_HEARTBEAT_MS);
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") ping();
    });
    return () => {
      clearInterval(timer);
      appState.remove();
    };
  }, [botId, hasControl, computer?.state]);

  useEffect(() => {
    if (ready && computer?.state === "running" && pinnedScreenUrl) {
      setComputerOpen(true);
    }
  }, [ready, computer?.state, pinnedScreenUrl]);

  async function openComputer() {
    if (!botId) return;
    const needsTakeover = computer?.controlHolder !== "user";
    try {
      await bootComputer({
        takeControl: needsTakeover,
        overlay: needsTakeover || computer?.state !== "running",
      });
      setComputerOpen(true);
      // The user asking again gives the screen a fresh reconnect budget.
      screenRetries.current = 0;
      setScreenLost(false);
      setScreenError(null);
    } catch {
      // error already set
    }
  }

  async function releaseComputer() {
    if (!botId) return;
    setError(null);
    try {
      await rpc("computer/release", { botId });
      setComputerOpen(false);
      setTrackpad(false);
      await refresh();
    } catch (err) {
      setError(computerFailureMessage(err, "Não foi possível liberar o computador"));
    }
  }

  async function pasteToComputer() {
    if (!botId) return;
    try {
      const text = await readClipboardText();
      if (!text) return;
      await rpc("computer/input", { botId, kind: "clipboard", payload: { text } });
    } catch (err) {
      setError(computerFailureMessage(err, "Não foi possível colar no computador"));
    }
  }

  function openComputerMenu() {
    setMenu(false);
    if (isIOS) {
      showNativeSheet({
        actions: [
          {
            label: trackpad ? "Sair do modo trackpad" : "Modo trackpad",
            onPress: () => setTrackpad((value) => !value),
          },
          { label: "Colar", onPress: () => void pasteToComputer() },
        ],
      });
      return;
    }
    setMenu((value) => !value);
  }

  const placeholder = screenError ?? previewPlaceholder(computer?.state, booting, name);

  // A tela do bot é a máquina, não cromo do app: ela continua escura e agora ocupa o
  // aparelho inteiro, subindo por baixo da barra de status. Antes vivia num quadro de 14
  // de raio com 20 de respiro em volta, e num celular isso virava um retângulo pequeno
  // cercado de branco.
  return (
    <View style={{ flex: 1, backgroundColor: SCREEN_BLACK }}>
      {/* Antes de assumir o controle a tela também é cheia e escura — e sem este cabeçalho
          não havia como voltar: só o gesto da borda, que ninguém descobre no preto. */}
      <View
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 5,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingHorizontal: 18,
          paddingTop: Math.max(insets.top, 14) + 6,
          paddingBottom: 12,
        }}
        pointerEvents="box-none"
      >
        <DarkIconButton symbol="chevron.left" label="Voltar" onPress={leaveComputer} />
        <Text
          numberOfLines={1}
          style={{ color: SCREEN_INK, fontSize: 19, fontWeight: "700", flex: 1, minWidth: 0 }}
        >
          {name}
        </Text>
      </View>
      {error ? (
        <Text style={{ color: COLORS.red, paddingHorizontal: 20, paddingTop: insets.top + 64 }}>
          {error}
        </Text>
      ) : null}
      <View style={{ flex: 1, backgroundColor: SCREEN_BLACK }}>
        {computerOpen ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: SCREEN_MUTED }}>Abrir em tela cheia</Text>
          </View>
        ) : computer?.state === "running" && pinnedScreenUrl ? (
          <ScreenWebView
            url={pinnedScreenUrl}
            interactive={false}
            onMessage={onScreenMessage}
            onError={() =>
              setScreenError(
                "Não foi possível carregar o desktop. Este aparelho não alcança a URL da tela.",
              )
            }
          />
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16 }}>
            {preview ? (
              <Image
                source={{ uri: preview }}
                contentFit="contain"
                transition={200}
                style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, opacity: 0.9 }}
              />
            ) : null}
            {computer?.state === "running" && !screenError ? (
              <View style={{ alignItems: "center", gap: 10 }}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void openComputer()}
                  style={{
                    backgroundColor: COLORS.primaryStrong,
                    paddingHorizontal: 26,
                    paddingVertical: 16,
                    borderRadius: 999,
                    shadowColor: "#000",
                    shadowOpacity: 0.45,
                    shadowRadius: 16,
                    shadowOffset: { width: 0, height: 8 },
                  }}
                >
                  <Text style={{ color: COLORS.background, fontWeight: "700", fontSize: 18 }}>
                    Assumir controle
                  </Text>
                </Pressable>
                <Text style={{ color: SCREEN_INK, fontSize: 13, opacity: 0.85 }}>
                  {preview ? "Prévia da tela, atualiza sozinha" : `Tela de ${name}`}
                </Text>
              </View>
            ) : (
              <Text style={{ color: SCREEN_MUTED, textAlign: "center" }}>{placeholder}</Text>
            )}
          </View>
        )}
        <Pressable
          accessibilityLabel="Abrir computador"
          onPress={() => void openComputer()}
          style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
        />
      </View>
      {/* Flutua sobre a tela: sobre o preto, texto escuro num rodapé branco não se lê. */}
      <View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          paddingHorizontal: 20,
          paddingTop: 14,
          paddingBottom: Math.max(insets.bottom, 14),
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          backgroundColor: "rgba(4,4,5,0.72)",
        }}
      >
        <Text style={{ color: SCREEN_MUTED, flex: 1, fontSize: 15 }}>
          {controlLabel(computer, name)}
        </Text>
        {hasControl ? (
          <Pressable
            onPress={() => void releaseComputer()}
            style={{
              backgroundColor: COLORS.card,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: COLORS.separator,
              paddingHorizontal: 16,
              paddingVertical: 10,
              borderRadius: 999,
            }}
          >
            <Text style={{ color: COLORS.primary, fontWeight: "600" }}>Liberar</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={() => void openComputer()}
            style={{
              backgroundColor: COLORS.primaryStrong,
              paddingHorizontal: 16,
              paddingVertical: 10,
              borderRadius: 999,
            }}
          >
            <Text style={{ color: COLORS.background, fontWeight: "600" }}>Assumir controle</Text>
          </Pressable>
        )}
      </View>

      <Modal
        visible={booting || computerOpen}
        animationType="fade"
        presentationStyle="fullScreen"
        onRequestClose={() => {
          if (!booting) setComputerOpen(false);
        }}
      >
        {booting ? (
          <View
            style={{
              flex: 1,
              backgroundColor: "rgba(4,4,5,0.96)",
              alignItems: "center",
              justifyContent: "center",
              gap: 22,
              padding: 24,
            }}
          >
            <Text
              style={{ color: SCREEN_INK, fontSize: 19, fontWeight: "500", textAlign: "center" }}
            >
              Abrindo a tela de {name} no seu computador
            </Text>
            <Text style={{ color: SCREEN_MUTED, fontSize: 14, textAlign: "center", maxWidth: 340 }}>
              Uma máquina compartilhada por você e pelos bots — cada um tem a tela dele nela.
            </Text>
            <View
              style={{
                height: 5,
                width: "70%",
                maxWidth: 420,
                overflow: "hidden",
                borderRadius: 999,
                backgroundColor: "#232327",
              }}
            >
              <View
                style={{
                  height: "100%",
                  width: "66%",
                  borderRadius: 999,
                  backgroundColor: SCREEN_INK,
                }}
              />
            </View>
          </View>
        ) : (
          <View style={{ flex: 1, backgroundColor: SCREEN_BLACK }}>
            {/* Dentro de um Modal o SafeAreaView não enxerga a área segura: o cabeçalho nascia
                por baixo do relógio e da bateria. O recuo vem dos insets medidos fora. */}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                paddingHorizontal: 18,
                paddingTop: Math.max(insets.top, 14) + 6,
                paddingBottom: 14,
              }}
            >
              <DarkIconButton
                symbol="chevron.left"
                label="Fechar computador"
                onPress={() => {
                  leaveComputer();
                }}
              />
              {/* Só a marca e o nome, como no chrome de tela cheia do sistema. */}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text
                  numberOfLines={1}
                  style={{ color: SCREEN_INK, fontSize: 19, fontWeight: "700" }}
                >
                  {name}
                </Text>
                {hasControl ? (
                  <Text style={{ color: "#4ECB71", fontSize: 13, marginTop: 1 }}>
                    {controlLabel(computer, name)}
                  </Text>
                ) : null}
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <DarkIconButton
                  symbol="square.grid.3x3"
                  label={hasControl ? "Modo trackpad" : "Assumir controle"}
                  onPress={() => {
                    if (hasControl) setTrackpad((value) => !value);
                    else {
                      void bootComputer({ takeControl: true, overlay: false }).catch(
                        () => undefined,
                      );
                    }
                  }}
                />
                <DarkIconButton symbol="ellipsis" label="Mais" onPress={openComputerMenu} />
                {menu && Platform.OS !== "ios" ? (
                  <GlassSurface
                    style={{
                      position: "absolute",
                      top: 48,
                      right: 8,
                      zIndex: 20,
                      overflow: "hidden",
                      borderRadius: 14,
                      minWidth: 180,
                      padding: 6,
                    }}
                  >
                    <Pressable
                      onPress={() => {
                        setTrackpad(true);
                        setMenu(false);
                      }}
                      style={{ padding: 12 }}
                    >
                      <Text style={{ color: SCREEN_INK }}>Modo trackpad</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        setMenu(false);
                        void pasteToComputer();
                      }}
                      style={{ padding: 12 }}
                    >
                      <Text style={{ color: SCREEN_INK }}>Colar</Text>
                    </Pressable>
                  </GlassSurface>
                ) : null}
              </View>
            </View>
            <View style={{ flex: 1, backgroundColor: SCREEN_BLACK }}>
              {computer?.state === "running" && pinnedScreenUrl ? (
                <ScreenWebView
                  url={pinnedScreenUrl}
                  interactive={hasControl && !trackpad}
                  onMessage={onScreenMessage}
                  onError={() =>
                    setScreenError(
                      "Não foi possível carregar o desktop. Este aparelho não alcança a URL da tela.",
                    )
                  }
                />
              ) : (
                <ScreenNotice
                  notice={screenNotice({
                    state: computer?.state,
                    booting,
                    hasControl,
                    error: screenError,
                    lost: screenLost,
                    name,
                  })}
                  onAction={(action) => {
                    setScreenError(null);
                    if (action === "retry") {
                      setScreenLost(false);
                      setScreenDrop((drop) => drop + 1);
                      return;
                    }
                    void bootComputer({
                      takeControl: action === "take-control" || action === "wake",
                      overlay: false,
                    }).catch(() => undefined);
                  }}
                />
              )}
              <TrackpadLayer botId={botId} enabled={trackpad} hasControl={hasControl} />
              {keyboardOpen ? (
                <TextInput
                  ref={keyboardInput}
                  accessibilityLabel="Digitar no computador"
                  autoCapitalize="none"
                  autoComplete="off"
                  autoCorrect={false}
                  blurOnSubmit={false}
                  multiline
                  onBlur={() => setKeyboardOpen(false)}
                  onChangeText={(value) => void sendTyped(value)}
                  spellCheck={false}
                  // Fora da vista, mas focável: quem aparece é o teclado do sistema.
                  style={{ position: "absolute", bottom: 0, height: 1, width: 1, opacity: 0 }}
                />
              ) : null}
              {/* Flutuam sobre a tela, como no chrome de tela cheia da referência. */}
              {hasControl && !trackpad ? (
                <View
                  style={{
                    position: "absolute",
                    left: 24,
                    right: 24,
                    bottom: Math.max(insets.bottom, 20),
                    flexDirection: "row",
                    justifyContent: "space-between",
                  }}
                >
                  <DarkIconButton
                    symbol="doc.on.clipboard"
                    label="Colar no computador"
                    onPress={() => void pasteToComputer()}
                  />
                  <DarkIconButton
                    symbol="keyboard"
                    label="Teclado"
                    onPress={() => {
                      typed.current = "";
                      setKeyboardOpen(true);
                      requestAnimationFrame(() => keyboardInput.current?.focus());
                    }}
                  />
                </View>
              ) : null}
              {trackpad ? (
                <Pressable
                  onPress={() => setTrackpad(false)}
                  style={{
                    position: "absolute",
                    bottom: 28,
                    alignSelf: "center",
                    left: 24,
                    right: 24,
                    alignItems: "center",
                  }}
                >
                  <View
                    style={{
                      backgroundColor: "rgba(44,44,46,0.92)",
                      borderRadius: 999,
                      paddingHorizontal: 16,
                      paddingVertical: 10,
                    }}
                  >
                    <Text style={{ color: SCREEN_INK, fontSize: 14 }}>
                      Modo trackpad · toque para sair
                    </Text>
                  </View>
                </Pressable>
              ) : null}
            </View>
          </View>
        )}
      </Modal>
    </View>
  );
}

/** O botão redondo do chrome de tela cheia: escuro, translúcido, sem borda. */
function DarkIconButton({
  symbol,
  label,
  onPress,
  size = 44,
}: {
  symbol: AppSymbolName;
  label: string;
  onPress: () => void;
  size?: number;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: SCREEN_CONTROL,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <AppSymbol name={symbol} size={20} color={SCREEN_INK} />
    </Pressable>
  );
}

function TrackpadLayer({
  botId,
  enabled,
  hasControl,
}: {
  botId?: string;
  enabled: boolean;
  hasControl: boolean;
}) {
  const last = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(0);
  const pointerMoves = useMemo(
    () =>
      createPointerMoveCoalescer(({ x, y }) => {
        if (!botId || !hasControl) return;
        // moveRelative, não move: o trackpad manda o DESLOCAMENTO do dedo. Com "move"
        // (absoluto) o cursor pulava para perto do canto a cada toque.
        void rpc("computer/input", {
          botId,
          kind: "pointer",
          payload: { x, y, type: "moveRelative" },
        });
      }),
    [botId, hasControl],
  );
  useEffect(() => () => pointerMoves.cancel(), [pointerMoves]);
  if (!enabled) return null;
  return (
    <View
      style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={(event) => {
        last.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
        moved.current = 0;
      }}
      onResponderMove={(event) => {
        if (!botId || !hasControl) return;
        const { pageX, pageY } = event.nativeEvent;
        const prev = last.current;
        last.current = { x: pageX, y: pageY };
        if (!prev) return;
        const x = pageX - prev.x;
        const y = pageY - prev.y;
        moved.current += Math.abs(x) + Math.abs(y);
        if (x === 0 && y === 0) return;
        pointerMoves.add({ x, y });
      }}
      onResponderRelease={() => {
        pointerMoves.flush();
        if (botId && hasControl && trackpadReleaseAction(moved.current) === "click") {
          // tap: clica onde o cursor parou. Antes era um click em (0,0) — teleportava
          // o cursor para o canto e clicava lá.
          void rpc("computer/input", {
            botId,
            kind: "pointer",
            payload: { x: 0, y: 0, type: "tap", button: "left" },
          });
        }
        last.current = null;
        moved.current = 0;
      }}
    />
  );
}

/** O que a tela cheia mostra no lugar do preto: motivo em uma frase e a saída. */
function ScreenNotice({
  notice,
  onAction,
}: {
  notice: ReturnType<typeof screenNotice>;
  onAction: (action: NonNullable<ReturnType<typeof screenNotice>["action"]>) => void;
}) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 8 }}>
      <Text style={{ color: SCREEN_INK, fontSize: 17, fontWeight: "600", textAlign: "center" }}>
        {notice.title}
      </Text>
      {notice.body ? (
        <Text style={{ color: SCREEN_MUTED, fontSize: 14, lineHeight: 20, textAlign: "center" }}>
          {notice.body}
        </Text>
      ) : null}
      {notice.action ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            softHaptic();
            onAction(notice.action as NonNullable<typeof notice.action>);
          }}
          style={{
            marginTop: 8,
            borderRadius: 999,
            backgroundColor: SCREEN_INK,
            paddingHorizontal: 20,
            paddingVertical: 11,
          }}
        >
          <Text style={{ color: "#101013", fontSize: 15, fontWeight: "600" }}>
            {notice.actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ScreenWebView({
  url,
  interactive,
  onError,
  onMessage,
}: {
  url: string;
  interactive: boolean;
  onError: () => void;
  /** Connection reports from the embed page; see `screenBridgeMessage`. */
  onMessage: (raw: unknown) => void;
}) {
  if (Platform.OS === "web") {
    return (
      <View style={{ flex: 1, overflow: "hidden", backgroundColor: "#000" }}>
        {createElement("iframe", {
          src: url,
          title: "Computador do agente",
          style: {
            width: "100%",
            height: "100%",
            border: 0,
            background: "#000",
            pointerEvents: interactive ? "auto" : "none",
          },
          onError,
        })}
      </View>
    );
  }
  return (
    <WebView
      key={url}
      source={{ uri: url }}
      onMessage={(event) => onMessage(event.nativeEvent.data)}
      style={{ flex: 1, backgroundColor: "#000" }}
      pointerEvents={interactive ? "auto" : "none"}
      javaScriptEnabled
      domStorageEnabled
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      originWhitelist={["http://*", "https://*"]}
      onShouldStartLoadWithRequest={(request) => allowScreenNavigation(request.url, url)}
      mixedContentMode="never"
      setSupportMultipleWindows={false}
      scrollEnabled={false}
      overScrollMode="never"
      onError={onError}
      onHttpError={onError}
    />
  );
}
