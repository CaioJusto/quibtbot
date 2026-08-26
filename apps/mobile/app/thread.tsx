import { ChatMarkdown } from "@quibt/chat-ui/native";
import { type LiveFeedStatus, startLiveFeed, threadEventNeedsSnapshotRefresh } from "@quibt/core";
import { DEFAULT_MARK_COLOR, multiAgentBursts } from "@quibt/ui-tokens";
import * as DocumentPicker from "expo-document-picker";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentMark } from "../lib/agent-mark";
import {
  applyMobileThreadEvent,
  authHeaders,
  blockText,
  currentApiBase,
  getGroup,
  getGroupThread,
  isSessionExpiredError,
  type MobileBot,
  type MobileGroup,
  type MobileMessage,
  mergeThreadSnapshot,
  rpc,
  type StreamEnd,
  sendToGroup,
  subscribeGroupThread,
  subscribeThread,
  type ThreadEvent,
} from "../lib/api";
import {
  type Attachment,
  attachmentTooBig,
  buildSendWithAttachmentsPayload,
  fileUrl,
  formatBytes,
  uploadAttachment,
} from "../lib/attachments";
import {
  applyOptimisticReaction,
  buildEditPayload,
  buildOptimisticUserMessage,
  buildReactPayload,
  buildSwitchBranchPayload,
  messageActions,
  quotedTextFor,
  rollbackMessages,
  versionsByParent,
  versionsOf,
} from "../lib/chat";
import { readClipboardText } from "../lib/clipboard";
import { type ContextMenuAnchor, ContextMenuSheet } from "../lib/context-menu-sheet";
import { DEMO_BOTS, demoMessagesForBot, demoReplyForBot, isDemoBotId } from "../lib/demo-inbox";
import {
  COLORS,
  GlassIconButton,
  GlassSurface,
  ScreenHeader,
  softHaptic,
} from "../lib/design-system";
import { FileViewer, type ViewerFile } from "../lib/file-viewer";
import {
  connectionChipLabel,
  createSafetyPoller,
  isConnectionProblem,
  RECONNECTING_CHIP_DELAY_MS,
  userFacingError,
} from "../lib/live-link";
import {
  activeComposerToken,
  insertMention,
  insertSlash,
  matchesMention,
  mentionedTargets,
} from "../lib/mentions";
import { AppSymbol, isIOS, showNativeSheet } from "../lib/native";
import { isPlanLimitError } from "../lib/plans";
import { createProgressCadence } from "../lib/progress-cadence";
import {
  type ApprovalKind,
  isNearBottom,
  reconcileThreadRows,
  type ThreadRow,
} from "../lib/thread-rows";
import {
  dictatedDraft,
  initialVoiceState,
  permissionEventFromResponse,
  recognitionErrorMessage,
  voiceReducer,
  voiceStatusMessage,
} from "../lib/voice";

const EVERYONE = "everyone";
const EMPTY_MESSAGES: MobileMessage[] = [];
const EMPTY_MEMBERS: MobileGroup["members"] = [];
const GROUP_MARK = 30;
const GROUP_GUTTER = 34;
const ACTIVE_RUN = ["running", "queued", "leased"];

/** Pílula de 48 mais o respiro de cima e de baixo: a folga que a conversa reserva. */
const COMPOSER_HEIGHT = 66;
const QUICK_REACTIONS = ["👍", "👎", "❤️", "😂", "🎉", "😮"];

/** O símbolo de cada ação no cartão do toque longo. */
const MESSAGE_MENU_SYMBOLS: Record<string, string> = {
  copy: "doc.on.doc",
  reply: "arrowshape.turn.up.left",
  edit: "pencil",
  "branch-prev": "chevron.left",
  "branch-next": "chevron.right",
};

type ThreadState = {
  cursor?: number;
  messages: MobileMessage[];
  run?: { id: string; botId: string; status: string } | null;
  runs?: Array<{ id: string; botId: string; status: string }>;
};

export default function Thread() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { botId, groupId, name, color, shape, demo } = useLocalSearchParams<{
    botId?: string;
    groupId?: string;
    name?: string;
    color?: string;
    shape?: string;
    demo?: string;
  }>();
  const isGroup = Boolean(groupId);
  const isDemo = demo === "1" || isDemoBotId(botId);
  const list = useRef<FlatList<ThreadRow>>(null);
  const draftInput = useRef<TextInput>(null);
  const pinnedToBottom = useRef(true);
  /**
   * Quando foi a última rolagem que nós mesmos pedimos. O evento de scroll que ela gera
   * chega com o conteúdo já maior (a resposta cresceu, a folga de baixo entrou) e, lido
   * como gesto da pessoa, dizia "saiu do fim" — e a conversa parava de seguir justamente
   * quando mais precisava. Por uma janela curta depois de um pedido nosso, o scroll não
   * desliga o "seguir o fim"; só o dedo da pessoa faz isso.
   */
  const programmaticScrollAt = useRef(0);
  /** Tamanho do conteúdo e da janela da lista, como a própria lista os mediu por último. */
  const contentHeightRef = useRef(0);
  const listHeightRef = useRef(0);
  const scrollListToEnd = useCallback((animated: boolean) => {
    programmaticScrollAt.current = Date.now();
    // Pelo deslocamento, e não por `scrollToEnd`: o fim é o conteúdo medido (com a folga
    // de baixo e o recuo do composer) menos a janela — igual em todo lugar.
    const offset = contentHeightRef.current - listHeightRef.current;
    if (contentHeightRef.current > 0 && listHeightRef.current > 0) {
      list.current?.scrollToOffset({ offset: Math.max(0, offset), animated });
      return;
    }
    list.current?.scrollToEnd({ animated });
  }, []);
  /**
   * Depois de enviar, a conversa tem que mostrar a mensagem que acabou de sair —
   * mesmo que o teclado tenha mexido no tamanho da lista e o `onScroll` tenha
   * concluído "não está no fim". Vale até a próxima mudança de conteúdo.
   */
  const revealNextContent = useRef(false);
  const autoFollowFrame = useRef<number | null>(null);
  const previousRows = useRef<ThreadRow[]>([]);
  const [snap, setSnap] = useState<ThreadState | null>(null);
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [replyTo, setReplyTo] = useState<MobileMessage | null>(null);
  const [editMessageId, setEditMessageId] = useState<string | null>(null);
  const [skills, setSkills] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [planLimitError, setPlanLimitError] = useState(false);
  /** Estado do fio (SSE), como o live-feed o vê: alimenta o chip "Reconectando…". */
  const [feedStatus, setFeedStatus] = useState<LiveFeedStatus>("connecting");
  /** Um poll que falhou por rede com o fio ainda "de pé": também é "reconectando". */
  const [pollFailed, setPollFailed] = useState(false);
  /** Se o bot está num run, para o poll de segurança decidir sem reabrir o efeito do fio. */
  const workingRef = useRef(false);
  /** Mesma ideia para o poll que falhou: insistir é o que apaga o chip. */
  const pollFailedRef = useRef(false);
  pollFailedRef.current = pollFailed;
  /**
   * Como o fluxo anterior terminou. Um socket que emudeceu (proxy segurando o SSE) volta
   * em cerca de um segundo e não merece chip; uma queda de verdade avisa na hora.
   */
  const streamEnd = useRef<StreamEnd>("closed");
  /** A reconexão já dura o bastante para valer o aviso na tela. */
  const [reconnectingSettled, setReconnectingSettled] = useState(true);
  const [bots, setBots] = useState<MobileBot[]>([]);
  const [group, setGroup] = useState<MobileGroup | null>(null);
  const [computerMenu, setComputerMenu] = useState(false);
  const [setupAnswers, setSetupAnswers] = useState<string[]>([]);
  const [setupPending, setSetupPending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [voice, setVoice] = useState(initialVoiceState);
  /** O que já estava no campo quando o microfone foi apertado: o ditado entra depois disso. */
  const dictationBase = useRef("");

  const members = group?.members ?? EMPTY_MEMBERS;
  const title = (isGroup ? group?.name : name) || name || (isGroup ? "Grupo" : "Conversa");

  useEffect(
    () => () => {
      if (autoFollowFrame.current !== null) {
        cancelAnimationFrame(autoFollowFrame.current);
      }
    },
    [],
  );

  const refresh = useCallback(async (): Promise<ThreadState | null> => {
    if (isDemo) return null;
    if (groupId) {
      const next = await getGroupThread(groupId);
      setSnap((prev) => mergeThreadSnapshot(prev, next));
      // Qualquer volta boa apaga o chip: enviar, reagir ou parar também provam que o
      // servidor responde, e antes só um `reload` limpava — o aviso ficava preso.
      setPollFailed(false);
      return next;
    }
    if (!botId) return null;
    const next = await rpc<ThreadState>("threads/get", { botId });
    setSnap((prev) => mergeThreadSnapshot(prev, next));
    setPollFailed(false);
    return next;
  }, [botId, groupId, isDemo]);

  useEffect(() => {
    if (isGroup || isDemo) return;
    void rpc<MobileBot[]>("bots/list")
      .then(setBots)
      .catch(() => undefined);
    void rpc<Array<{ id: string; name: string; kind: string }>>("capabilities/list")
      .then((rows) =>
        setSkills(rows.filter((row) => row.kind === "skill").map(({ id, name }) => ({ id, name }))),
      )
      .catch(() => undefined);
  }, [isDemo, isGroup]);

  useEffect(() => {
    if (!isDemo) return;
    setBots(DEMO_BOTS);
    setSnap({ messages: demoMessagesForBot(botId) });
    setError(null);
  }, [botId, isDemo]);

  useEffect(() => {
    if (!groupId) return;
    void getGroup(groupId)
      .then(setGroup)
      .catch(() => undefined);
  }, [groupId]);

  useEffect(() => {
    if (isDemo) return;
    if (!botId && !groupId) return;
    let stopped = false;
    let reloadInFlight = false;
    let live: ReturnType<typeof startLiveFeed> | null = null;
    // A 401 already dropped the stored token: reconnecting only reprints "Sessão expirada"
    // behind a backoff. Stop the feed at the first one and send the user to the login.
    const sessionExpired = () => {
      if (stopped) return;
      stopped = true;
      live?.stop();
      router.replace("/welcome");
    };
    const reload = async () => {
      if (reloadInFlight || stopped) return;
      reloadInFlight = true;
      try {
        await refresh();
        setError(null);
        setPollFailed(false);
      } catch (err) {
        if (isSessionExpiredError(err)) sessionExpired();
        else if (isConnectionProblem(err instanceof Error ? err.message : null)) {
          // Rede caída é o chip discreto, não o banner vermelho com "Network request failed".
          setPollFailed(true);
        } else {
          setError(userFacingError(err, "Não foi possível atualizar a conversa"));
          setPlanLimitError(isPlanLimitError(err));
        }
      } finally {
        reloadInFlight = false;
      }
    };
    // Instante do último evento que chegou pelo fio: o poll de segurança só entra em cena
    // quando o bot trabalha e isto envelhece (proxy segurando o SSE), ou com o fio caído.
    let lastEventAt = Date.now();
    // Suaviza o streaming: uma rajada de `thread.progress` (cada um com o texto já
    // acumulado) vira um flush a cada ~60 ms, em vez de dezenas de re-renders. Eventos
    // estruturais descarregam o progress pendente e aplicam na hora — ordem preservada.
    const cadence = createProgressCadence((event) =>
      setSnap((prev) => applyMobileThreadEvent(prev, event as ThreadEvent)),
    );
    const onEvent = (event: { type: string }) => {
      lastEventAt = Date.now();
      if (
        event.type === "thread.progress" ||
        event.type === "thread.message.created" ||
        event.type === "thread.cleared" ||
        event.type === "run.completed" ||
        event.type === "run.failed" ||
        event.type === "run.cancelled"
      ) {
        cadence.push(event as ThreadEvent);
      }
      if (threadEventNeedsSnapshotRefresh(event.type)) {
        void reload();
      }
    };
    // Streams events over SSE; if the socket dies (network change, backgrounding, server
    // restart) it polls until it can reconnect from the latest cursor.
    setFeedStatus("connecting");
    const feed = startLiveFeed({
      onStatus: setFeedStatus,
      connect: async (signal, opened) => {
        streamEnd.current = "closed";
        const next = await refresh();
        setError(null);
        // O silêncio conta do fio recém-aberto, não de antes de o app dormir: sem isto,
        // voltar do segundo plano no meio de um run fazia o poll buscar o retrato inteiro
        // a cada 2 s enquanto a ferramenta rodava, justamente o tráfego que cortamos.
        lastEventAt = Date.now();
        if (signal.aborted) return;
        // `opened` é o que leva o estado a "connected"; sem ele o chip nunca saberia que
        // o fio voltou. O stream avisa quando a resposta chegou com corpo.
        const open = () => {
          lastEventAt = Date.now();
          opened();
        };
        if (groupId) {
          streamEnd.current = await subscribeGroupThread(
            groupId,
            next?.cursor ?? -1,
            onEvent,
            signal,
            {
              onOpen: open,
            },
          );
        } else if (botId) {
          streamEnd.current = await subscribeThread(botId, next?.cursor ?? -1, onEvent, signal, {
            onOpen: open,
          });
        }
      },
      refresh: reload,
      onError: (err) => {
        if (isSessionExpiredError(err)) {
          sessionExpired();
          return;
        }
        // Fio caindo é o chip "Reconectando…"; o banner fica para o que a pessoa precisa ler.
        if (
          err instanceof Error &&
          !/cannot stream|failed \(\d+\)/.test(err.message) &&
          !isConnectionProblem(err.message)
        ) {
          setError(err.message);
          setPlanLimitError(isPlanLimitError(err));
        }
      },
    });
    live = feed;
    let paused = false;
    // O SSE continua sendo o caminho imediato. O poll de segurança rodava a cada 1,5 s
    // sempre — e cada volta trocava o snapshot: o fio tremia. Agora só entra com o fio caído
    // ou quando o bot trabalha e nada chega há mais de 8 s (proxy antigo segurando o SSE),
    // e o snapshot entra por merge (`mergeThreadSnapshot`), sem apagar o que o fio já mostra.
    const stopSafetyPoll = createSafetyPoller({
      status: () => feed.status(),
      working: () => workingRef.current,
      lastEventAt: () => lastEventAt,
      pollFailed: () => pollFailedRef.current,
      paused: () => paused,
      reload: () => void reload(),
    });
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "background" && !paused) {
        paused = true;
        feed.pause();
      } else if (state === "active" && paused) {
        paused = false;
        feed.resume();
      }
    });
    return () => {
      stopped = true;
      stopSafetyPoll();
      cadence.dispose();
      appState.remove();
      feed.stop();
    };
  }, [botId, groupId, isDemo, refresh]);

  /**
   * Num proxy que bufferiza o SSE o vigia derruba o socket mudo a cada ~16 s e a volta leva
   * cerca de um segundo: o chip piscava "Reconectando…" com tudo funcionando. Uma queda de
   * verdade (o servidor fechou, o fluxo nem abriu) continua avisando na hora.
   */
  useEffect(() => {
    if (feedStatus !== "reconnecting") {
      setReconnectingSettled(true);
      return;
    }
    if (streamEnd.current !== "stalled") {
      setReconnectingSettled(true);
      return;
    }
    setReconnectingSettled(false);
    const timer = setTimeout(() => setReconnectingSettled(true), RECONNECTING_CHIP_DELAY_MS);
    return () => clearTimeout(timer);
  }, [feedStatus]);

  const composerToken = activeComposerToken(draft, caret);
  const mentionCandidates = useMemo(
    () =>
      isGroup
        ? [{ id: EVERYONE, name: EVERYONE, color: COLORS.secondary, shape: undefined }, ...members]
        : bots.filter((bot) => bot.id !== botId),
    [isGroup, members, bots, botId],
  );
  const tokenMatches = useMemo(() => {
    if (!composerToken) return [];
    if (composerToken.kind === "skill") {
      return skills
        .filter((skill) => matchesMention(skill.name, composerToken.query))
        .slice(0, 6)
        .map((skill) => ({ ...skill, kind: "skill" as const }));
    }
    return mentionCandidates
      .filter((peer) => matchesMention(peer.name, composerToken.query))
      .slice(0, 6)
      .map((peer) => ({ ...peer, kind: "mention" as const }));
  }, [composerToken, mentionCandidates, skills]);

  const working = isGroup
    ? (snap?.runs ?? []).some((run) => ACTIVE_RUN.includes(run.status))
    : Boolean(snap?.run && ACTIVE_RUN.includes(snap.run.status));
  workingRef.current = working;
  const connectionChip = isDemo
    ? null
    : connectionChipLabel({ status: feedStatus, pollFailed, reconnectingSettled });

  async function stopWorkingRuns() {
    if (isDemo || stopping) return;
    const botIds = isGroup
      ? [
          ...new Set(
            (snap?.runs ?? [])
              .filter((run) => ACTIVE_RUN.includes(run.status))
              .map((run) => run.botId),
          ),
        ]
      : botId
        ? [botId]
        : [];
    if (botIds.length === 0) return;
    setError(null);
    setStopping(true);
    try {
      await Promise.all(botIds.map((id) => rpc("threads/stop", { botId: id })));
      const stopped = new Set(botIds);
      setSnap((current) =>
        current
          ? {
              ...current,
              run: isGroup ? current.run : null,
              runs: isGroup
                ? (current.runs ?? []).filter((run) => !stopped.has(run.botId))
                : current.runs,
              messages: current.messages.filter((message) => !message.id.startsWith("progress:")),
            }
          : current,
      );
      await refresh().catch(() => undefined);
    } catch (err) {
      if (isSessionExpiredError(err)) router.replace("/welcome");
      else setError(userFacingError(err, "Não foi possível parar o agente"));
    } finally {
      setStopping(false);
    }
  }

  async function attachPickedFiles(
    files: Array<{ uri: string; name: string; mimeType: string; size: number }>,
  ) {
    if (!botId || isDemo || isGroup) return;
    setAttaching(true);
    setError(null);
    try {
      const headers = await authHeaders();
      for (const file of files.slice(0, 8 - attachments.length)) {
        if (attachmentTooBig(file.size)) {
          setError(`${file.name} passa de 25 MB.`);
          continue;
        }
        const stored = await uploadAttachment(botId, file, {
          apiBase: currentApiBase(),
          authHeaders: headers,
        });
        setAttachments((current) => [...current, stored]);
      }
    } catch (err) {
      setError(userFacingError(err, "Não foi possível anexar"));
    } finally {
      setAttaching(false);
    }
  }

  async function pickImage() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.92,
    });
    if (result.canceled || !result.assets.length) return;
    await attachPickedFiles(
      result.assets.map((asset) => ({
        uri: asset.uri,
        name: asset.fileName ?? `imagem-${Date.now()}.jpg`,
        mimeType: asset.mimeType ?? "image/jpeg",
        size: asset.fileSize ?? 0,
      })),
    );
  }

  async function pickDocument() {
    const result = await DocumentPicker.getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.length) return;
    await attachPickedFiles(
      result.assets.map((asset) => ({
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType ?? "application/octet-stream",
        size: asset.size ?? 0,
      })),
    );
  }

  /**
   * Ditado: toque para pedir o microfone e começar a ouvir; toque de novo para parar. O
   * que a pessoa fala vai entrando no campo (parciais e depois o final) atrás do que já
   * estava escrito; ela manda quando quiser, como se tivesse digitado. Tudo no aparelho:
   * funciona num grupo, sem servidor de transcrição e sem o modelo precisar ouvir áudio.
   */
  useSpeechRecognitionEvent("result", (event) => {
    const transcript = event.results[0]?.transcript ?? "";
    const next = dictatedDraft(dictationBase.current, transcript);
    setDraft(next);
    setCaret(next.length);
  });
  useSpeechRecognitionEvent("end", () => {
    setVoice((current) =>
      current.phase === "listening"
        ? voiceReducer(current, { type: "listening-stopped" })
        : current,
    );
  });
  useSpeechRecognitionEvent("error", (event) => {
    // "aborted" é o nosso próprio stop/abort chegando como evento; não é erro para a pessoa.
    if (event.error === "aborted") {
      setVoice((current) =>
        current.phase === "listening"
          ? voiceReducer(current, { type: "listening-stopped" })
          : current,
      );
      return;
    }
    setVoice((current) =>
      voiceReducer(current, { type: "error", message: recognitionErrorMessage(event.error) }),
    );
  });
  async function toggleVoice() {
    if (voice.phase === "listening") {
      ExpoSpeechRecognitionModule.stop();
      setVoice((current) => voiceReducer(current, { type: "listening-stopped" }));
      draftInput.current?.focus();
      return;
    }
    setVoice((current) => voiceReducer(current, { type: "mic-press" }));
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    setVoice((current) => voiceReducer(current, permissionEventFromResponse(permission)));
    if (!permission.granted) return;
    dictationBase.current = draft;
    try {
      ExpoSpeechRecognitionModule.start({
        lang: "pt-BR",
        interimResults: true,
        continuous: true,
        maxAlternatives: 1,
        addsPunctuation: true,
      });
    } catch (err) {
      setVoice((current) =>
        voiceReducer(current, {
          type: "error",
          message: err instanceof Error ? err.message : recognitionErrorMessage(undefined),
        }),
      );
    }
  }

  async function send() {
    if ((!botId && !groupId) || (!draft.trim() && !attachments.length)) return;
    const text = draft;
    const pendingAttachments = attachments;
    const pendingReply = replyTo;
    const editing = editMessageId;
    setDraft("");
    setCaret(0);
    setAttachments([]);
    setReplyTo(null);
    setEditMessageId(null);
    setError(null);
    setPlanLimitError(false);
    pinnedToBottom.current = true;
    revealAnimated.current = true;
    revealNextContent.current = true;
    // A mensagem enviada tem de aparecer na hora, com teclado aberto ou não.
    requestAnimationFrame(() => scrollListToEnd(true));
    if (isDemo) {
      const stamp = Date.now();
      setSnap((current) => ({
        messages: [
          ...(current?.messages ?? demoMessagesForBot(botId)),
          {
            id: `demo:user:${stamp}`,
            role: "user",
            blocks: [{ kind: "text", text }],
            createdAt: new Date(stamp).toISOString(),
          },
          {
            id: `demo:bot:${stamp}`,
            role: "bot",
            blocks: [{ kind: "text", text: demoReplyForBot(botId) }],
            createdAt: new Date(stamp + 1_000).toISOString(),
          },
        ],
      }));
      return;
    }
    const clientNonce = editing ? null : newClientNonce();
    if (clientNonce) {
      const optimistic = buildOptimisticUserMessage({
        clientNonce,
        text,
        attachments: pendingAttachments,
        replyToId: pendingReply?.id,
      }) as MobileMessage;
      setSnap((current) =>
        current ? { ...current, messages: [...current.messages, optimistic] } : current,
      );
    }
    if (groupId) {
      const mentioned = mentionedTargets(text, members);
      try {
        await sendToGroup(
          groupId,
          text,
          mentioned.map((member) => member.id),
          clientNonce ?? undefined,
        );
        await refresh();
        revealSent();
      } catch (err) {
        if (clientNonce) {
          setSnap((current) =>
            current
              ? {
                  ...current,
                  messages: current.messages.filter(
                    (message) => message.clientNonce !== clientNonce,
                  ),
                }
              : current,
          );
        }
        setDraft(text);
        setError(userFacingError(err, "Não foi possível enviar"));
        setPlanLimitError(isPlanLimitError(err));
      }
      return;
    }
    const mentioned = mentionedTargets(
      text,
      bots.filter((bot) => bot.id !== botId),
    );
    if (!botId) return;
    try {
      if (editing) {
        await rpc("threads/edit", buildEditPayload({ botId, messageId: editing, text }));
      } else {
        await rpc(
          "threads/send",
          buildSendWithAttachmentsPayload({
            botId,
            text,
            clientNonce: clientNonce ?? undefined,
            attachments: pendingAttachments,
            replyToId: pendingReply?.id,
            mentionBotIds: mentioned.length ? mentioned.map((peer) => peer.id) : undefined,
          }),
        );
      }
      await refresh();
      revealSent();
    } catch (err) {
      if (clientNonce) {
        setSnap((current) =>
          current
            ? {
                ...current,
                messages: current.messages.filter((message) => message.clientNonce !== clientNonce),
              }
            : current,
        );
      }
      setDraft(text);
      setCaret(text.length);
      setAttachments(pendingAttachments);
      setReplyTo(pendingReply);
      setEditMessageId(editing);
      setError(userFacingError(err, "Não foi possível enviar"));
      setPlanLimitError(isPlanLimitError(err));
    }
  }

  const reactToMessage = useCallback(
    async (messageId: string, emoji: string) => {
      if (!botId || isDemo || isGroup) return;
      const snapshot = snap?.messages ?? EMPTY_MESSAGES;
      setSnap((current) =>
        current
          ? { ...current, messages: applyOptimisticReaction(current.messages, messageId, emoji) }
          : current,
      );
      try {
        await rpc("threads/react", buildReactPayload({ botId, messageId, emoji }));
        await refresh();
      } catch (err) {
        setSnap((current) =>
          current
            ? { ...current, messages: rollbackMessages(current.messages, snapshot) }
            : current,
        );
        setError(userFacingError(err, "Não foi possível reagir"));
        setPlanLimitError(isPlanLimitError(err));
      }
    },
    [botId, isDemo, isGroup, refresh, snap?.messages],
  );

  const switchBranch = useCallback(
    async (messageId: string) => {
      if (!botId || isDemo || isGroup) return;
      setError(null);
      try {
        await rpc("threads/switchBranch", buildSwitchBranchPayload({ botId, messageId }));
        await refresh();
      } catch (err) {
        setError(userFacingError(err, "Não foi possível trocar a versão"));
        setPlanLimitError(isPlanLimitError(err));
      }
    },
    [botId, isDemo, isGroup, refresh],
  );

  /** As entradas do cartão do "+": mesmas funções de antes, no estilo do menu ancorado. */
  function addMenuEntries() {
    const entries: Array<{ label: string; systemImage: string; onPress: () => void }> = [];
    if (botId && !isDemo && !isGroup) {
      entries.push(
        {
          label: "Escolher foto",
          systemImage: "photo.on.rectangle",
          onPress: () => void pickImage(),
        },
        { label: "Escolher arquivo", systemImage: "folder", onPress: () => void pickDocument() },
      );
    }
    if (isGroup) {
      entries.push({
        label: "Mencionar alguém",
        systemImage: "at",
        onPress: () => {
          const next = draft && !/\s$/.test(draft) ? `${draft} @` : `${draft}@`;
          setDraft(next);
          setCaret(next.length);
          draftInput.current?.focus();
        },
      });
    }
    entries.push({
      label: "Colar texto",
      systemImage: "doc.on.clipboard",
      onPress: () => {
        void readClipboardText().then((text) => {
          if (!text) return;
          setDraft((current) => (current ? `${current}\n${text}` : text));
          draftInput.current?.focus();
        });
      },
    });
    return entries;
  }

  function openAddMenu() {
    addButton.current?.measureInWindow((x, y, width, height) => {
      setAddMenuAnchor({ x, y, width, height });
    });
  }

  const voiceMessage = voiceStatusMessage(voice);

  /**
   * O composer flutua, então quem manda na altura dele é o teclado, não o
   * `KeyboardAvoidingView`: o pai só empurra filhos no fluxo, e uma pílula
   * absoluta ancorada embaixo ficava atrás do teclado quando ele subia.
   */
  const [keyboardInset, setKeyboardInset] = useState(0);
  /**
   * A folga que a conversa reserva embaixo é a altura real do dock, medida no layout:
   * ele cresce quando entra um anexo, uma citação ou o aviso de voz, e uma altura fixa
   * deixava a última mensagem escondida atrás justamente nesses momentos.
   */
  const [dockHeight, setDockHeight] = useState(COMPOSER_HEIGHT);
  /** Falso quando a pessoa rolou para cima: aparece a setinha de voltar ao fim. */
  const [atBottom, setAtBottom] = useState(true);
  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const shown = Keyboard.addListener(showEvent, (event) => {
      setKeyboardInset(event.endCoordinates.height);
    });
    const hidden = Keyboard.addListener(hideEvent, () => setKeyboardInset(0));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  /**
   * O teclado subindo cresce a folga de baixo na mesma medida — e a última mensagem, que
   * estava à vista, some atrás dele. Quem estava lendo o fim continua lendo o fim.
   */
  useEffect(() => {
    if (!pinnedToBottom.current) return;
    const frame = requestAnimationFrame(() => {
      scrollListToEnd(keyboardInset > 0);
    });
    return () => cancelAnimationFrame(frame);
  }, [keyboardInset, dockHeight, scrollListToEnd]);
  const messages = snap?.messages ?? EMPTY_MESSAGES;
  const versionIndex = useMemo(() => versionsByParent(messages), [messages]);

  /**
   * O menu do toque longo numa mensagem, no estilo do menu de contexto do sistema:
   * emojis em cima, ações num cartão colado à bolha — em vez do action sheet empilhado
   * no meio da tela.
   */
  const [messageMenu, setMessageMenu] = useState<{
    message: MobileMessage;
    anchor: ContextMenuAnchor;
    mine: boolean;
    versionIndex?: number;
    versionCount?: number;
  } | null>(null);
  /** O cartão do "+" do composer, ancorado no próprio botão. */
  const [addMenuAnchor, setAddMenuAnchor] = useState<ContextMenuAnchor | null>(null);
  /** O arquivo aberto no visualizador (imagem, vídeo, texto) — dentro do app. */
  const [viewerFile, setViewerFile] = useState<ViewerFile | null>(null);
  const openViewer = useCallback((file: ViewerFile) => setViewerFile(file), []);
  const addButton = useRef<View>(null);

  const handleMessageAction = useCallback(
    (message: MobileMessage, kind: string) => {
      softHaptic();
      const text = blockText(message);
      if (kind === "copy") {
        void import("../lib/clipboard").then(({ writeClipboardText }) => writeClipboardText(text));
        return;
      }
      if (kind === "reply") {
        setReplyTo(message);
        draftInput.current?.focus();
        return;
      }
      if (kind === "react") {
        showNativeSheet({
          title: "Reagir",
          actions: QUICK_REACTIONS.map((emoji) => ({
            label: emoji,
            onPress: () => void reactToMessage(message.id, emoji),
          })),
        });
        return;
      }
      if (kind === "edit") {
        setDraft(text);
        setCaret(text.length);
        setEditMessageId(message.id);
        draftInput.current?.focus();
        return;
      }
      if (kind === "branch-prev" || kind === "branch-next") {
        const versions = versionsOf(versionIndex, message);
        const index = versions.findIndex((row) => row.id === message.id);
        const next = versions[index + (kind === "branch-next" ? 1 : -1)];
        if (next) void switchBranch(next.id);
      }
    },
    [reactToMessage, switchBranch, versionIndex],
  );

  const answerSetup = useCallback(
    async (answer: string) => {
      if (!botId || setupPending) return;
      softHaptic();
      const next = [...setupAnswers, answer];
      setSetupAnswers(next);
      if (next.length < 2) return;
      setSetupPending(true);
      setError(null);
      try {
        await rpc("threads/send", {
          botId,
          text: `Quero principalmente ajuda com ${next[0]}. Prefiro respostas ${next[1]}.`,
        });
        await refresh();
      } catch (err) {
        setSetupAnswers(next.slice(0, 1));
        setError(userFacingError(err, "Não foi possível salvar suas preferências"));
      } finally {
        setSetupPending(false);
      }
    },
    [botId, refresh, setupAnswers, setupPending],
  );

  const answer = useCallback(
    async (runId: string | undefined, answerBotId: string | undefined, value: string) => {
      if (!runId || !answerBotId) return;
      setError(null);
      setPlanLimitError(false);
      try {
        await rpc("threads/answer", { botId: answerBotId, runId, answer: value });
        await refresh();
      } catch (err) {
        setError(userFacingError(err, "Não foi possível responder o bot"));
        setPlanLimitError(isPlanLimitError(err));
      }
    },
    [refresh],
  );

  /** Se a lista já tinha a mensagem (chegou pelo feed ao vivo), o tamanho não muda: rola agora. */
  const revealSent = useCallback(() => {
    // Não consome o sinal de "revelar": ele é do evento de tamanho do conteúdo, que é
    // quem sabe a altura nova. Aqui é só a ida imediata ao fim do que já existe.
    requestAnimationFrame(() => {
      pinnedToBottom.current = true;
      setAtBottom(true);
      scrollListToEnd(true);
    });
  }, [scrollListToEnd]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const near = isNearBottom(event.nativeEvent);
    // Rolagem que nós pedimos há pouco: o conteúdo pode ter crescido no meio do caminho;
    // não é a pessoa saindo do fim. Só aceita o "saiu" vindo de um gesto.
    if (!near && Date.now() - programmaticScrollAt.current < 900) return;
    pinnedToBottom.current = near;
    setAtBottom((current) => (current === near ? current : near));
  }, []);

  /** A setinha: volta ao fim e volta a seguir a conversa. */
  const jumpToEnd = useCallback(() => {
    softHaptic();
    pinnedToBottom.current = true;
    setAtBottom(true);
    scrollListToEnd(true);
  }, [scrollListToEnd]);

  function openComputerPicker() {
    if (!members.length) return;
    const actions = members.map((member) => ({
      label: member.name,
      onPress: () =>
        router.push({
          pathname: "/computer",
          params: {
            botId: member.id,
            name: member.name,
            color: member.color,
            shape: member.shape ?? "",
          },
        }),
    }));
    if (isIOS) {
      showNativeSheet({ title: "Abrir computador", actions });
      return;
    }
    setComputerMenu((value) => !value);
  }

  function openSettings() {
    if (isGroup) {
      router.push({ pathname: "/group-settings", params: { groupId: groupId ?? "", name: title } });
      return;
    }
    router.push({
      pathname: "/settings",
      params: {
        botId: botId ?? "",
        name: name ?? "Bot",
        color: color ?? "",
        shape: shape ?? "",
        demo: isDemo ? "1" : "0",
      },
    });
  }

  function openComputer() {
    if (isDemo) {
      showNativeSheet({
        title: "Computador",
        message: "O computador fica disponível nos seus bots reais.",
        actions: [],
      });
      return;
    }
    if (isGroup) {
      openComputerPicker();
      return;
    }
    router.push({
      pathname: "/computer",
      params: { botId: botId ?? "", name: name ?? "Bot", color: color ?? "", shape: shape ?? "" },
    });
  }

  let headerPing: MobileBot | null = null;
  if (!isGroup) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]!;
      if (message.role === "user") break;
      const id = message.fromBotId;
      if (id && id !== botId) {
        headerPing = bots.find((bot) => bot.id === id) ?? {
          id,
          name: "outro bot",
          preview: "",
          title: "",
        };
        break;
      }
    }
  }
  const showConversationSetup =
    !isGroup && snap !== null && messages.length === 0 && setupAnswers.length < 2;
  const burstByLastId = useMemo(() => {
    if (isGroup) return {} as Record<string, ReturnType<typeof multiAgentBursts>[number]>;
    const bursts = multiAgentBursts(
      messages.map((message) => ({
        id: message.id,
        role: message.role,
        authorId:
          message.authorBotId ?? message.fromBotId ?? (message.role === "bot" ? botId : null),
      })),
    );
    return Object.fromEntries(bursts.map((burst) => [burst.lastMessageId, burst]));
  }, [isGroup, messages, botId]);
  const burstAuthorsByLastId = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(burstByLastId).map(([lastMessageId, burst]) => [
          lastMessageId,
          burstAuthorsFor(burst.authorIds, bots),
        ]),
      ),
    [bots, burstByLastId],
  );
  // Neighbour-dependent layout (bundling, day stamps, the group mark on the last bubble of
  // a run) is resolved over the whole thread, so virtualizing the list cannot change it.
  const rows = useMemo(
    () =>
      reconcileThreadRows(previousRows.current, {
        messages,
        botId,
        bots,
        members,
        isGroup,
      }),
    [messages, botId, bots, members, isGroup],
  );
  useEffect(() => {
    previousRows.current = rows;
  }, [rows]);

  // Conversas curtas ficam apoiadas no composer; as longas rolam normalmente.
  const listTopPadding = insets.top + 82;
  const listBottomPadding = dockHeight + 14 + keyboardInset;
  /** Enviar anima a ida ao fim; abrir a conversa chega lá sem animação. */
  const revealAnimated = useRef(false);
  // Abrir a conversa sempre mostra a mensagem mais recente junto do composer.
  const openedAtEnd = useRef(false);
  useEffect(() => {
    if (openedAtEnd.current || rows.length === 0) return;
    openedAtEnd.current = true;
    revealAnimated.current = false;
    revealNextContent.current = true;
  }, [rows.length]);

  const openMessageMenu = useCallback(
    (
      message: MobileMessage,
      anchor: ContextMenuAnchor,
      mine: boolean,
      msgVersionIndex?: number,
      msgVersionCount?: number,
    ) => {
      setMessageMenu({
        message,
        anchor,
        mine,
        versionIndex: msgVersionIndex,
        versionCount: msgVersionCount,
      });
    },
    [],
  );

  const renderRow = useCallback(
    ({ item }: { item: ThreadRow }) => {
      const burst = burstByLastId[item.key];
      const versions = versionsOf(versionIndex, item.message);
      const versionIdx = versions.findIndex((row) => row.id === item.message.id);
      return (
        <MessageRow
          id={item.key}
          message={item.message}
          text={blockText(item.message)}
          quoted={quotedTextFor(messages, item.message.replyToId)}
          streaming={item.key.startsWith("progress:")}
          mine={item.mine}
          bundled={item.bundled}
          stamp={item.stamp}
          from={item.from}
          isGroup={isGroup}
          versionIndex={versionIdx >= 0 ? versionIdx : undefined}
          versionCount={versions.length > 1 ? versions.length : undefined}
          authorName={item.authorName}
          authorColor={item.authorColor}
          authorShape={item.authorShape}
          showAuthorMark={item.showAuthorMark}
          approval={item.approval}
          runId={item.message.runId}
          answerBotId={item.answerBotId}
          onAnswer={answer}
          onAction={handleMessageAction}
          onMenu={openMessageMenu}
          onOpenFile={openViewer}
          burstMessages={burst?.messages}
          burstAuthors={burstAuthorsByLastId[item.key]}
        />
      );
    },
    [
      answer,
      burstAuthorsByLastId,
      burstByLastId,
      handleMessageAction,
      isGroup,
      messages,
      openMessageMenu,
      openViewer,
      versionIndex,
      working,
    ],
  );

  const listHeader = useMemo(
    () => (
      <>
        {headerPing ? (
          <View style={styles.headerPing}>
            <Text style={styles.headerPingText}>Mensagem de</Text>
            <AgentMark
              color={headerPing.color ?? DEFAULT_MARK_COLOR}
              shape={headerPing.shape}
              size={16}
            />
            <Text style={styles.headerPingText}>{headerPing.name}</Text>
          </View>
        ) : null}
        {showConversationSetup ? (
          <ConversationSetup
            name={title}
            color={typeof color === "string" && color ? color : COLORS.blue}
            shape={typeof shape === "string" ? shape : undefined}
            answers={setupAnswers}
            pending={setupPending}
            onAnswer={(value) => void answerSetup(value)}
          />
        ) : null}
      </>
    ),
    [
      answerSetup,
      headerPing,
      showConversationSetup,
      title,
      color,
      shape,
      setupAnswers,
      setupPending,
    ],
  );

  return (
    <View style={styles.screen}>
      <ScreenHeader
        onBack={() => router.back()}
        title={title}
        color={
          isGroup ? undefined : typeof color === "string" && color ? color : DEFAULT_MARK_COLOR
        }
        shape={typeof shape === "string" ? shape : undefined}
        members={isGroup ? members : undefined}
        onTitlePress={openSettings}
        right={
          <GlassIconButton symbol="desktopcomputer" label="Computador" onPress={openComputer} />
        }
      />

      {/*
        Sem `behavior`: quem sobe com o teclado é o dock flutuante, pelo
        `keyboardInset`. Deixar o padding aqui também empurraria tudo duas vezes.
      */}
      <KeyboardAvoidingView style={styles.flex} behavior={undefined}>
        {computerMenu && !isIOS ? (
          <GlassSurface style={[styles.computerMenu, { top: insets.top + 68 }]}>
            {members.map((member) => (
              <Pressable
                key={member.id}
                onPress={() => {
                  setComputerMenu(false);
                  router.push({
                    pathname: "/computer",
                    params: {
                      botId: member.id,
                      name: member.name,
                      color: member.color,
                      shape: member.shape ?? "",
                    },
                  });
                }}
                style={styles.computerRow}
              >
                <AgentMark color={member.color} shape={member.shape} size={24} />
                <Text style={styles.computerName}>{member.name}</Text>
              </Pressable>
            ))}
          </GlassSurface>
        ) : null}

        {connectionChip && !error ? (
          // O chip vive por cima da conversa, como o aviso de erro: entrar e sair do fluxo
          // faria a lista pular justamente enquanto a rede oscila.
          <View
            accessibilityLiveRegion="polite"
            pointerEvents="none"
            style={[styles.linkChipRow, { top: insets.top + 74 }]}
          >
            <View style={styles.linkChip}>
              <View
                style={[
                  styles.linkDot,
                  { backgroundColor: feedStatus === "offline" ? COLORS.red : COLORS.orange },
                ]}
              />
              <Text style={styles.linkChipText}>{connectionChip}</Text>
            </View>
          </View>
        ) : null}

        {error ? (
          // Por cima da conversa, nunca no fluxo: um aviso que entra e sai (um poll que
          // falhou e voltou) encolhia a lista em ~100 px e fazia o chat pular.
          <Pressable
            onPress={() => planLimitError && router.push("/billing")}
            style={[styles.errorBox, { top: insets.top + 74 }]}
          >
            <Text style={styles.errorText}>
              {error}
              {planLimitError ? "  Ver planos" : ""}
            </Text>
          </Pressable>
        ) : null}

        <FlatList
          ref={list}
          data={rows}
          keyExtractor={keyOfRow}
          renderItem={renderRow}
          ListHeaderComponent={listHeader}
          onLayout={(event) => {
            listHeightRef.current = event.nativeEvent.layout.height;
          }}
          style={styles.flex}
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: "flex-end",
            paddingTop: listTopPadding,
            paddingHorizontal: 16,
            // O composer flutua por cima; sem esta folga a última mensagem nasce embaixo dele.
            paddingBottom: listBottomPadding,
          }}
          onScroll={onScroll}
          scrollEventThrottle={64}
          initialNumToRender={16}
          maxToRenderPerBatch={12}
          windowSize={9}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={(_width, height) => {
            contentHeightRef.current = height;
            if (revealNextContent.current) {
              revealNextContent.current = false;
              pinnedToBottom.current = true;
              setAtBottom(true);
              scrollListToEnd(revealAnimated.current);
              return;
            }
            if (!pinnedToBottom.current) return;
            if (autoFollowFrame.current !== null) return;
            autoFollowFrame.current = requestAnimationFrame(() => {
              autoFollowFrame.current = null;
              if (pinnedToBottom.current) scrollListToEnd(false);
            });
          }}
        />

        {!atBottom ? (
          <View
            pointerEvents="box-none"
            style={[styles.jumpToEnd, { bottom: keyboardInset + dockHeight + 10 }]}
          >
            <GlassIconButton
              symbol="arrow.down"
              label="Ir para a última mensagem"
              size={40}
              symbolSize={18}
              onPress={jumpToEnd}
            />
          </View>
        ) : null}

        {/* Meta e composer flutuam como um bloco só, senão a pílula cobre os anexos. */}
        <View
          onLayout={(event) => setDockHeight(event.nativeEvent.layout.height)}
          style={[styles.composerDock, { bottom: keyboardInset }]}
        >
          {/*
            A lista de @ e de /skills mora no dock: fora dele ficava no fim do fluxo, atrás
            da pílula e do teclado — quem digitava @ num grupo não via opção nenhuma.
          */}
          {tokenMatches.length ? (
            <GlassSurface style={styles.mentionMenu}>
              {tokenMatches.map((peer) => (
                <Pressable
                  key={peer.id}
                  onPress={() => {
                    const next =
                      peer.kind === "skill"
                        ? insertSlash(draft, caret, peer.name)
                        : insertMention(draft, caret, peer.name);
                    if (typeof next === "string") {
                      setDraft(next);
                      setCaret(next.length);
                    } else {
                      setDraft(next.text);
                      setCaret(next.caret);
                    }
                    draftInput.current?.focus();
                  }}
                  style={styles.mentionRow}
                >
                  {peer.kind === "skill" ? (
                    <View style={styles.everyoneMark}>
                      <AppSymbol name="doc.text" size={15} color={COLORS.secondary} />
                    </View>
                  ) : peer.id === EVERYONE ? (
                    <View style={styles.everyoneMark}>
                      <AppSymbol name="person.2.fill" size={15} color={COLORS.secondary} />
                    </View>
                  ) : (
                    <AgentMark
                      color={
                        "color" in peer ? (peer.color ?? DEFAULT_MARK_COLOR) : DEFAULT_MARK_COLOR
                      }
                      shape={"shape" in peer ? peer.shape : undefined}
                      size={24}
                    />
                  )}
                  <Text style={styles.mentionName}>
                    {peer.kind === "skill" ? "/" : "@"}
                    {peer.name}
                  </Text>
                  {peer.kind === "mention" && peer.id === EVERYONE ? (
                    <Text style={styles.mentionHint}>todos do grupo</Text>
                  ) : null}
                </Pressable>
              ))}
            </GlassSurface>
          ) : null}

          {(replyTo || editMessageId || attachments.length || attaching || voiceMessage) && (
            <View style={styles.composerMeta}>
              {replyTo ? (
                <View style={styles.composerMetaRow}>
                  <AppSymbol name="paperclip" size={14} color={COLORS.secondary} />
                  <Text style={styles.composerMetaText} numberOfLines={1}>
                    {quotedTextFor(messages, replyTo.id) ?? "Recado citado"}
                  </Text>
                  <Pressable accessibilityLabel="Cancelar citação" onPress={() => setReplyTo(null)}>
                    <AppSymbol name="xmark" size={14} color={COLORS.secondary} />
                  </Pressable>
                </View>
              ) : null}
              {editMessageId ? (
                <View style={styles.composerMetaRow}>
                  <AppSymbol name="doc.text" size={14} color={COLORS.secondary} />
                  <Text style={styles.composerMetaText}>Editar e ramificar</Text>
                  <Pressable
                    accessibilityLabel="Cancelar edição"
                    onPress={() => setEditMessageId(null)}
                  >
                    <AppSymbol name="xmark" size={14} color={COLORS.secondary} />
                  </Pressable>
                </View>
              ) : null}
              {attachments.map((file) => (
                <View key={file.id} style={styles.composerMetaRow}>
                  <AppSymbol name="paperclip" size={14} color={COLORS.secondary} />
                  <Text style={styles.composerMetaText} numberOfLines={1}>
                    {file.name}
                  </Text>
                  <Pressable
                    accessibilityLabel={`Tirar ${file.name}`}
                    onPress={() =>
                      setAttachments((current) => current.filter((row) => row.id !== file.id))
                    }
                  >
                    <AppSymbol name="xmark" size={14} color={COLORS.secondary} />
                  </Pressable>
                </View>
              ))}
              {attaching ? <Text style={styles.composerMetaHint}>enviando…</Text> : null}
              {voiceMessage ? (
                <View style={styles.composerMetaRow}>
                  <AppSymbol name="mic.fill" size={14} color={COLORS.secondary} />
                  <Text style={styles.composerMetaText} numberOfLines={2}>
                    {voiceMessage}
                  </Text>
                  {voice.phase !== "listening" && voice.phase !== "requesting-permission" ? (
                    <Pressable
                      accessibilityLabel="Fechar aviso de voz"
                      onPress={() => setVoice(initialVoiceState)}
                    >
                      <AppSymbol name="xmark" size={14} color={COLORS.secondary} />
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
            </View>
          )}

          <View
            style={[
              styles.composer,
              { paddingBottom: keyboardInset > 0 ? 10 : Math.max(insets.bottom, 10) },
            ]}
          >
            <View ref={addButton} collapsable={false}>
              <GlassIconButton
                symbol="plus"
                label="Adicionar"
                size={48}
                symbolSize={25}
                onPress={openAddMenu}
              />
            </View>
            <GlassSurface interactive clear style={styles.composerField}>
              <TextInput
                ref={draftInput}
                value={draft}
                onChangeText={(value) => {
                  setDraft(value);
                  setCaret(value.length);
                }}
                onSelectionChange={(event) =>
                  setCaret(event.nativeEvent.selection.end ?? draft.length)
                }
                placeholder={editMessageId ? "Editar e ramificar" : `Pergunte ${title}`}
                placeholderTextColor={COLORS.tertiary}
                onSubmitEditing={() => void send()}
                returnKeyType="send"
                blurOnSubmit={false}
                style={styles.composerInput}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  working
                    ? stopping
                      ? "Parando agente"
                      : "Parar agente"
                    : voice.phase === "listening"
                      ? "Parar de ouvir"
                      : draft.trim() || attachments.length
                        ? "Enviar"
                        : "Ditar"
                }
                disabled={stopping || voice.phase === "requesting-permission"}
                onPress={() => {
                  softHaptic();
                  if (working) {
                    void stopWorkingRuns();
                    return;
                  }
                  // Ouvindo, o botão é o quadrado de parar — mesmo com o campo já cheio do
                  // que foi ditado; mandar é o toque seguinte.
                  if (voice.phase !== "listening" && (draft.trim() || attachments.length)) {
                    void send();
                    return;
                  }
                  void toggleVoice();
                }}
                style={[
                  styles.composerAction,
                  working || draft.trim() || attachments.length || voice.phase === "listening"
                    ? styles.composerActionReady
                    : null,
                ]}
              >
                <AppSymbol
                  name={
                    working || voice.phase === "listening"
                      ? "stop.fill"
                      : draft.trim() || attachments.length
                        ? "arrow.up"
                        : "mic.fill"
                  }
                  size={21}
                  // Pronto para enviar, o botão fica preto — o ícone tem que virar papel.
                  color={
                    working || draft.trim() || attachments.length || voice.phase === "listening"
                      ? COLORS.background
                      : COLORS.secondary
                  }
                />
              </Pressable>
            </GlassSurface>
          </View>
        </View>
        {/* Toque longo numa mensagem: emojis em cima, ações num cartão colado à bolha. */}
        <ContextMenuSheet
          visible={Boolean(messageMenu)}
          anchor={messageMenu?.anchor ?? null}
          alignRight={messageMenu?.mine ?? false}
          onClose={() => setMessageMenu(null)}
          accessory={
            messageMenu && !isGroup && messageMenu.message.role !== "user" ? (
              <View style={styles.menuReactionRow}>
                {QUICK_REACTIONS.map((emoji) => (
                  <Pressable
                    key={emoji}
                    accessibilityRole="button"
                    accessibilityLabel={`Reagir com ${emoji}`}
                    onPress={() => {
                      const target = messageMenu.message.id;
                      setMessageMenu(null);
                      void reactToMessage(target, emoji);
                    }}
                    style={({ pressed }) => [
                      styles.menuReactionBubble,
                      pressed && styles.menuReactionBubblePressed,
                    ]}
                  >
                    <Text style={styles.menuReactionEmoji}>{emoji}</Text>
                  </Pressable>
                ))}
              </View>
            ) : undefined
          }
          entries={
            messageMenu
              ? messageActions({
                  message: messageMenu.message,
                  isGroup,
                  working,
                  versionIndex: messageMenu.versionIndex,
                  versionCount: messageMenu.versionCount,
                })
                  // A fileira de emojis já é o "Reagir" — o item duplicado sai do cartão.
                  .filter((action) => action.kind !== "react")
                  .map((action) => ({
                    label: action.label,
                    systemImage: MESSAGE_MENU_SYMBOLS[action.kind] ?? "ellipsis.circle",
                    onPress: () => handleMessageAction(messageMenu.message, action.kind),
                  }))
              : []
          }
        />

        {/* O "+" do composer: as mesmas opções, num cartão ancorado no botão. */}
        <ContextMenuSheet
          visible={Boolean(addMenuAnchor)}
          anchor={addMenuAnchor}
          onClose={() => setAddMenuAnchor(null)}
          entries={addMenuEntries()}
        />

        <FileViewer
          file={viewerFile}
          apiBase={currentApiBase()}
          authHeaders={authHeaders}
          onClose={() => setViewerFile(null)}
        />
      </KeyboardAvoidingView>
    </View>
  );
}

const SETUP_QUESTIONS = [
  {
    prompt: "Pra começar: o que você mais quer tirar da sua mão agora?",
    options: ["Inbox e mensagens", "Código e projetos", "Pesquisa e escrita", "Um pouco de tudo"],
  },
  {
    prompt: "Boa. E como você prefere que eu responda?",
    options: ["Claro e curto", "Mais conversado", "Polido e formal", "Direto ao ponto"],
  },
] as const;

function ConversationSetup({
  name,
  color,
  shape,
  answers,
  pending,
  onAnswer,
}: {
  name: string;
  color: string;
  shape?: string;
  answers: string[];
  pending: boolean;
  onAnswer: (answer: string) => void;
}) {
  const question = SETUP_QUESTIONS[answers.length] ?? SETUP_QUESTIONS[1];
  return (
    <View style={styles.setupFlow}>
      <View style={styles.setupPeer}>
        <AgentMark color={color} shape={shape} size={34} online />
        <Text style={styles.setupPeerName}>{name}</Text>
      </View>
      <View style={[styles.bubble, styles.agentBubble, styles.setupBubble]}>
        <Text style={styles.messageText}>{question.prompt}</Text>
      </View>
      {answers[0] ? (
        <View style={[styles.bubble, styles.mineBubble, styles.setupAnswerBubble]}>
          <Text style={[styles.messageText, styles.mineText]}>{answers[0]}</Text>
        </View>
      ) : null}
      <View style={styles.setupOptions}>
        {question.options.map((option) => (
          <Pressable
            key={option}
            disabled={pending}
            onPress={() => onAnswer(option)}
            style={({ pressed }) => [styles.setupOption, pressed && styles.setupOptionPressed]}
          >
            <Text style={styles.setupOptionText}>{option}</Text>
            <AppSymbol name="chevron.right" size={17} color={COLORS.blue} />
          </Pressable>
        ))}
      </View>
      <Text style={styles.setupHint}>
        Perguntas rápidas do próprio agente — você pode mudar tudo depois.
      </Text>
    </View>
  );
}

type BurstAuthor = { id: string; color: string; shape?: string };

function burstAuthorsFor(ids: string[], bots: MobileBot[]): BurstAuthor[] {
  return ids.map((id) => {
    const bot = bots.find((candidate) => candidate.id === id);
    return { id, color: bot?.color ?? DEFAULT_MARK_COLOR, shape: bot?.shape };
  });
}

function newClientNonce() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Stable identity for the virtualized list: the id the server gave the message. */
function keyOfRow(row: ThreadRow) {
  return row.key;
}

function AttachmentImage({ artifactId, name }: { artifactId: string; name: string }) {
  const [headers, setHeaders] = useState<Record<string, string>>({});
  useEffect(() => {
    void authHeaders()
      .then(setHeaders)
      .catch(() => undefined);
  }, []);
  return (
    <Image
      source={{ uri: fileUrl(artifactId, currentApiBase()), headers }}
      style={styles.attachmentImage}
      accessibilityLabel={name}
      contentFit="cover"
    />
  );
}

/**
 * One chat bubble. Receives only primitives so React can skip it while a sibling streams;
 * with a long thread this is the difference between smooth and stuttering typing.
 */
const MessageRow = memo(function MessageRow({
  message,
  text,
  quoted,
  streaming,
  mine,
  bundled,
  stamp,
  from,
  isGroup,
  versionIndex,
  versionCount,
  authorName,
  authorColor,
  authorShape,
  showAuthorMark,
  approval,
  runId,
  answerBotId,
  onAnswer,
  onAction,
  onMenu,
  onOpenFile,
  burstMessages,
  burstAuthors,
}: {
  id: string;
  message: MobileMessage;
  text: string;
  quoted?: string;
  streaming: boolean;
  mine: boolean;
  bundled: boolean;
  stamp: string | null;
  from: string | null;
  isGroup: boolean;
  versionIndex?: number;
  versionCount?: number;
  authorName?: string;
  authorColor?: string;
  authorShape?: string;
  showAuthorMark: boolean;
  approval: ApprovalKind;
  runId?: string;
  answerBotId?: string;
  onAnswer: (runId: string | undefined, botId: string | undefined, value: string) => void;
  onAction: (message: MobileMessage, kind: string) => void;
  onMenu: (
    message: MobileMessage,
    anchor: ContextMenuAnchor,
    mine: boolean,
    versionIndex?: number,
    versionCount?: number,
  ) => void;
  onOpenFile: (file: ViewerFile) => void;
  burstMessages?: number;
  burstAuthors?: BurstAuthor[];
}) {
  const fileBlocks = message.blocks.filter((block) => block.kind === "file");
  // File blocks render as cards below; everything else (text, subagent, child_bot)
  // is concatenated by blockText so a message that carries both a text block and a
  // subagent/child_bot block still shows all of it in the bubble.
  const displayText = fileBlocks.length
    ? blockText({ ...message, blocks: message.blocks.filter((block) => block.kind !== "file") })
    : text;
  const reactions = Object.entries(message.reactions ?? {}).filter(([, who]) => who.length > 0);

  const block = useRef<View>(null);
  return (
    <Pressable
      ref={block as never}
      // Um toque na conversa guarda o teclado, como em qualquer app de mensagens.
      onPress={() => Keyboard.dismiss()}
      onLongPress={() => {
        softHaptic();
        block.current?.measureInWindow((x, y, width, height) => {
          onMenu(message, { x, y, width, height }, mine, versionIndex, versionCount);
        });
      }}
      delayLongPress={320}
      style={[styles.messageBlock, bundled && styles.bundled]}
    >
      {stamp ? <Text style={styles.centerMeta}>{stamp}</Text> : null}
      {from ? <Text style={styles.centerMeta}>{from}</Text> : null}
      {isGroup && !mine && !bundled && authorName ? (
        <Text style={styles.authorName}>{authorName}</Text>
      ) : null}
      {quoted ? (
        <View style={[styles.quoted, mine && styles.quotedMine]}>
          <AppSymbol name="paperclip" size={12} color={COLORS.secondary} />
          <Text style={styles.quotedText} numberOfLines={2}>
            {quoted}
          </Text>
        </View>
      ) : null}
      {fileBlocks.map((block, index) => (
        <View
          key={`${block.artifactId ?? index}`}
          style={[
            styles.messageLine,
            mine && styles.messageLineMine,
            index > 0 ? styles.fileGap : null,
          ]}
        >
          {block.image && block.artifactId ? (
            <Pressable
              accessibilityRole="imagebutton"
              accessibilityLabel={`Abrir ${block.name ?? "imagem"}`}
              onPress={() =>
                onOpenFile({
                  artifactId: block.artifactId ?? "",
                  name: block.name ?? "imagem",
                  mimeType: block.mimeType ?? "image/png",
                  size: block.size,
                })
              }
            >
              <AttachmentImage artifactId={block.artifactId} name={block.name ?? "imagem"} />
            </Pressable>
          ) : (
            <Pressable
              onPress={() => {
                if (!block.artifactId) return;
                onOpenFile({
                  artifactId: block.artifactId,
                  name: block.name ?? "arquivo",
                  mimeType: block.mimeType,
                  size: block.size,
                });
              }}
              style={[styles.fileCard, mine && styles.fileCardMine]}
            >
              <View style={[styles.fileIcon, mine && styles.fileIconMine]}>
                <AppSymbol
                  name="paperclip"
                  size={18}
                  color={mine ? COLORS.mineInk : COLORS.secondary}
                />
              </View>
              <View style={styles.fileMeta}>
                <Text style={[styles.fileName, mine && styles.mineText]} numberOfLines={1}>
                  {block.name ?? "arquivo"}
                </Text>
                <Text style={[styles.fileSize, mine && styles.fileSizeMine]}>
                  {formatBytes(block.size ?? 0)}
                </Text>
              </View>
            </Pressable>
          )}
        </View>
      ))}
      {displayText ? (
        <View style={[styles.messageLine, mine && styles.messageLineMine]}>
          {isGroup && !mine ? (
            <View style={styles.groupGutter}>
              {showAuthorMark && authorColor ? (
                <AgentMark color={authorColor} shape={authorShape} size={GROUP_MARK} />
              ) : null}
            </View>
          ) : null}
          <View style={[styles.bubble, mine ? styles.mineBubble : styles.agentBubble]}>
            {mine ? (
              <Text style={[styles.messageText, styles.mineText]}>{displayText}</Text>
            ) : (
              <ChatMarkdown streaming={streaming}>{displayText}</ChatMarkdown>
            )}
            {approval ? (
              <View style={styles.approvalActions}>
                {approval === "tool" || approval === "tool-once" ? (
                  <>
                    <Pressable
                      onPress={() => onAnswer(runId, answerBotId, "deny")}
                      style={styles.approvalSecondary}
                    >
                      <Text style={styles.approvalSecondaryText}>Recusar</Text>
                    </Pressable>
                    {approval === "tool" ? (
                      <Pressable
                        onPress={() => onAnswer(runId, answerBotId, "always")}
                        style={styles.approvalSecondary}
                      >
                        <Text style={styles.approvalSecondaryText}>Sempre</Text>
                      </Pressable>
                    ) : null}
                    <Pressable
                      onPress={() => onAnswer(runId, answerBotId, "allow")}
                      style={styles.approvalPrimary}
                    >
                      <Text style={styles.approvalPrimaryText}>Permitir</Text>
                    </Pressable>
                  </>
                ) : (
                  <Pressable
                    onPress={() => onAnswer(runId, answerBotId, "approved")}
                    style={styles.approvalPrimary}
                  >
                    <Text style={styles.approvalPrimaryText}>Enviar</Text>
                  </Pressable>
                )}
              </View>
            ) : null}
          </View>
        </View>
      ) : null}
      {reactions.length ? (
        <View style={[styles.reactions, mine && styles.reactionsMine]}>
          {reactions.map(([emoji, who]) => (
            <Pressable
              key={emoji}
              onPress={() => onAction(message, "react")}
              style={styles.reactionChip}
            >
              <Text style={styles.reactionEmoji}>{emoji}</Text>
              {who.length > 1 ? <Text style={styles.reactionCount}>{who.length}</Text> : null}
            </Pressable>
          ))}
        </View>
      ) : null}
      {versionCount && versionCount > 1 ? (
        <Text style={[styles.versionMeta, mine && styles.versionMetaMine]}>
          {(versionIndex ?? 0) + 1}/{versionCount}
        </Text>
      ) : null}
      {burstMessages && burstAuthors ? (
        <View style={styles.burstLine}>
          <Text style={styles.burstText}>{burstMessages} mensagens com</Text>
          {burstAuthors.map((author) => (
            <AgentMark key={author.id} color={author.color} shape={author.shape} size={16} />
          ))}
          <Text style={styles.burstText}>{burstAuthors.length} agentes</Text>
        </View>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  flex: { flex: 1 },
  computerMenu: {
    position: "absolute",
    right: 18,
    zIndex: 30,
    minWidth: 190,
    borderRadius: 18,
    paddingVertical: 6,
  },
  computerRow: {
    minHeight: 48,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  computerName: { color: COLORS.primary, fontSize: 16, fontWeight: "600" },
  errorBox: {
    position: "absolute",
    left: 18,
    right: 18,
    zIndex: 25,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: COLORS.card,
  },
  errorText: { color: COLORS.red, fontSize: 14 },
  linkChipRow: { position: "absolute", left: 0, right: 0, zIndex: 24, alignItems: "center" },
  linkChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 5,
    paddingHorizontal: 11,
    borderRadius: 999,
    backgroundColor: COLORS.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.separator,
  },
  linkDot: { width: 7, height: 7, borderRadius: 4 },
  linkChipText: { color: COLORS.secondary, fontSize: 13, fontWeight: "600" },
  headerPing: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    marginBottom: 10,
  },
  headerPingText: { color: COLORS.secondary, fontSize: 14, fontWeight: "600" },
  setupFlow: { marginTop: 4, paddingBottom: 18 },
  setupPeer: { flexDirection: "row", alignItems: "center", gap: 9, marginBottom: 8 },
  setupPeerName: { color: COLORS.secondary, fontSize: 15, fontWeight: "700" },
  setupBubble: { alignSelf: "flex-start" },
  setupAnswerBubble: { alignSelf: "flex-end", marginTop: 10 },
  setupOptions: { gap: 8, marginTop: 12 },
  setupOption: {
    minHeight: 50,
    borderRadius: 17,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.separator,
    backgroundColor: COLORS.card,
    paddingHorizontal: 15,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  setupOptionPressed: { backgroundColor: COLORS.cardRaised, transform: [{ scale: 0.992 }] },
  setupOptionText: { color: COLORS.primary, fontSize: 15, fontWeight: "600", flex: 1 },
  setupHint: { color: COLORS.tertiary, fontSize: 12, lineHeight: 17, marginTop: 11 },
  messageBlock: { marginTop: 14, width: "100%" },
  bundled: { marginTop: 3 },
  centerMeta: {
    color: COLORS.tertiary,
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
    marginBottom: 9,
  },
  authorName: {
    color: COLORS.secondary,
    fontSize: 13,
    fontWeight: "600",
    marginLeft: GROUP_GUTTER + 9,
    marginBottom: 4,
  },
  messageLine: { flexDirection: "row", alignItems: "flex-start", justifyContent: "flex-start" },
  messageLineMine: { alignItems: "flex-end", justifyContent: "flex-end" },
  groupGutter: { width: GROUP_GUTTER, alignItems: "flex-start", alignSelf: "flex-end" },
  bubble: {
    flexShrink: 1,
    minWidth: 0,
    maxWidth: "90%",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 14,
  },
  mineBubble: { backgroundColor: COLORS.mineBubble },
  mineText: { color: COLORS.mineInk },
  agentBubble: { backgroundColor: COLORS.bubble },
  messageText: { color: COLORS.primary, fontSize: 16, lineHeight: 23 },
  approvalActions: {
    marginTop: 12,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  approvalSecondary: {
    minHeight: 40,
    backgroundColor: COLORS.background,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.separator,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  approvalSecondaryText: { color: COLORS.primary, fontSize: 15, fontWeight: "600" },
  approvalPrimary: {
    minHeight: 40,
    backgroundColor: COLORS.primaryStrong,
    borderRadius: 999,
    paddingHorizontal: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  approvalPrimaryText: { color: COLORS.background, fontSize: 15, fontWeight: "700" },
  burstLine: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    marginTop: 12,
  },
  burstText: { color: COLORS.secondary, fontSize: 15, fontWeight: "600" },
  mentionMenu: { marginHorizontal: 18, marginBottom: 8, borderRadius: 16, padding: 6 },
  /** A fileira de reações acima do cartão do toque longo. */
  menuReactionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: COLORS.background,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 8,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
  },
  menuReactionBubble: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  menuReactionBubblePressed: { backgroundColor: COLORS.card },
  menuReactionEmoji: { fontSize: 24 },
  mentionRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 9,
  },
  everyoneMark: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: COLORS.cardRaised,
    alignItems: "center",
    justifyContent: "center",
  },
  mentionName: { color: COLORS.primary, fontSize: 16 },
  mentionHint: { color: COLORS.tertiary, fontSize: 13 },
  composerDock: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
  /** A setinha de voltar ao fim, encostada à direita logo acima do composer. */
  jumpToEnd: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  composer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingTop: 8,
    paddingHorizontal: 18,
  },
  composerField: {
    flex: 1,
    height: 48,
    borderRadius: 24,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 16,
    paddingRight: 5,
  },
  composerInput: { flex: 1, color: COLORS.primary, fontSize: 16, paddingVertical: 0 },
  composerAction: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: COLORS.separator,
    alignItems: "center",
    justifyContent: "center",
  },
  composerActionReady: { backgroundColor: COLORS.primaryStrong },
  composerMeta: {
    marginHorizontal: 18,
    marginBottom: 8,
    gap: 6,
  },
  composerMetaRow: {
    minHeight: 34,
    borderRadius: 12,
    backgroundColor: COLORS.card,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  composerMetaText: { flex: 1, color: COLORS.secondary, fontSize: 14 },
  composerMetaHint: { color: COLORS.tertiary, fontSize: 13, paddingHorizontal: 4 },
  quoted: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: COLORS.card,
    alignSelf: "flex-start",
    maxWidth: "90%",
  },
  quotedMine: { alignSelf: "flex-end" },
  quotedText: { flex: 1, color: COLORS.secondary, fontSize: 13 },
  attachmentImage: {
    width: 220,
    height: 220,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.separator,
  },
  fileGap: { marginTop: 8 },
  fileCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    maxWidth: "90%",
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.separator,
    backgroundColor: COLORS.card,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  // O cartão de arquivo da pessoa acompanha a bolha dela: no escuro, o preto invertido
  // deixava o nome do arquivo ilegível.
  fileCardMine: { backgroundColor: COLORS.mineBubble, borderColor: COLORS.mineBubble },
  fileIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: COLORS.tile,
    alignItems: "center",
    justifyContent: "center",
  },
  fileMeta: { flexShrink: 1, minWidth: 0 },
  fileName: { color: COLORS.primary, fontSize: 15, fontWeight: "600" },
  fileSize: { color: COLORS.secondary, fontSize: 13, marginTop: 2 },
  fileSizeMine: { color: COLORS.mineInk, opacity: 0.7 },
  fileIconMine: { backgroundColor: "rgba(127,127,127,0.25)" },
  reactions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 6,
    alignSelf: "flex-start",
  },
  reactionsMine: { alignSelf: "flex-end" },
  reactionChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.separator,
    backgroundColor: COLORS.card,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  reactionEmoji: { fontSize: 16 },
  reactionCount: { color: COLORS.secondary, fontSize: 12, fontWeight: "600" },
  versionMeta: {
    marginTop: 4,
    color: COLORS.tertiary,
    fontSize: 12,
    fontWeight: "600",
    alignSelf: "flex-start",
  },
  versionMetaMine: { alignSelf: "flex-end" },
});
