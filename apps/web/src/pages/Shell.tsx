import type {
  BillingSnapshot,
  Bot,
  BotGroup,
  CapabilityInstall,
  ComputerStatus,
  Connection,
  GroupThreadSnapshot,
  Routine,
  ThreadMessage,
  ThreadSnapshot,
} from "@quibt/contracts";
import type { LiveFeedStatus } from "@quibt/core";
import {
  controlUntilLabel,
  createPointerMoveCoalescer,
  cronFromPreset,
  defaultCronPreset,
  deviceTimezone,
  formatCron,
  isPlanLimitError,
  lessonPrompt,
  needsModelConnection,
  presetFromCron,
  startLiveFeed,
  startPolling,
  threadEventNeedsSnapshotRefresh,
  trackpadKeyInput,
  trackpadReleaseAction,
  withControlLease,
} from "@quibt/core";
import { multiAgentBursts } from "@quibt/ui-tokens";
import { BotAvatar, Button, Switch } from "@quibt/ui-web";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import computerDesktopImage from "../../../www/public/computer-desktop-ice-blue.webp?url";
import { GlassSurface, Icon, MenuItem } from "../components/desktop-ui";
import { WorkerDownNotice, workerAliveRefresher } from "../components/WorkerDownNotice";
import { applyGroupThreadEvent, applyThreadEvent } from "../lib/apply-thread-event";
import { type Attachment, attachmentTooBig, uploadAttachment } from "../lib/attachments";
import { authClient } from "../lib/auth";
import { buildPaletteItems, opensPalette, type PaletteItem } from "../lib/command-palette";
import { dayStamps } from "../lib/day-stamps";
import { desktopBridge, trafficLightInset } from "../lib/desktop";
import { shortcutFromKey, starterPrompts, visibleShortcutTargets } from "../lib/desktop-shortcuts";
import {
  activeComposerToken,
  insertMention,
  insertSlash,
  matchesMention,
  mentionedTargets,
} from "../lib/mentions";
import { versionsByParent, versionsOf } from "../lib/message-versions";
import {
  createPreviewPoller,
  holdsComputerControl,
  othersHoldControl,
  type PreviewFrame,
  previewAgeLabel,
  previewAgeMs,
  previewIsStale,
  shouldPollPreview,
} from "../lib/preview-poll";
import { rpc } from "../lib/rpc";
import { errorMessage } from "../lib/rpc-errors";
import {
  decideScreenUrl,
  embeddableScreenUrl,
  planScreenReconnect,
  screenFrameEvent,
  screenIframeSandbox,
  shouldFetchScreenUrl,
} from "../lib/screen-url";
import { groupAuthor, peerAuthor } from "../lib/thread-authors";
import type { TranscribeStatus } from "../lib/transcribe";
import { isAnsweringMessage } from "../lib/turn-start";
import { createVoiceRecorder, extensionFor, formatDuration, voiceSupported } from "../lib/voice";
import { AccountSheet } from "./AccountSheet";
import { AgentSettings, InstructionsPanel, MemoryPanel } from "./AgentSettings";
import { CommandPalette } from "./CommandPalette";
import { ComputerPreview } from "./ComputerPreview";
import { CreateBotForm } from "./CreateBotForm";
import { GroupAvatar } from "./GroupAvatar";
import { GroupMembersPane, NewGroupForm } from "./GroupPanels";
import { HostComputerPrompt } from "./HostComputerPrompt";
import { Inbox } from "./Inbox";
import { BurstSummary, MessageView } from "./MessageView";
import { PluginsOverlay } from "./PluginsOverlay";
import { RoutineSchedule } from "./RoutineSchedule";
import { type SettingsPage, SettingsPanel } from "./SettingsPanel";
import { WebhooksPanel } from "./WebhooksPanel";

type Panel =
  | "computer"
  | "settings"
  | "instructions"
  | "memory"
  | "webhooks"
  | "routine"
  | "create"
  | "members"
  | "create-group"
  | null;

type MentionCandidate = {
  id: string;
  name: string;
  title?: string;
  color?: string;
  shape?: string | null;
  everyone?: boolean;
  kind?: "bot" | "group" | "routine" | "connector" | "skill" | "everyone";
};

const ACTIVE_RUN = ["running", "queued", "leased"];

/** Keep the heavy transcription path out of the initial chat bundle. */
function transcriptionSupported(): boolean {
  return typeof Worker !== "undefined" && typeof AudioContext !== "undefined";
}

function emptyRoutineDraft() {
  return {
    id: "",
    name: "",
    prompt: "",
    schedule: defaultCronPreset(),
    active: true,
  };
}

/** Idempotency key for a send; `crypto.randomUUID` is missing on plain-http LAN origins. */
function newClientNonce() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function ShellPage() {
  const { botId, groupId } = useParams();
  const navigate = useNavigate();
  const session = authClient.useSession();
  const [bots, setBots] = useState<Bot[]>([]);
  const [groups, setGroups] = useState<BotGroup[]>([]);
  const [query, setQuery] = useState("");
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const [groupSnapshot, setGroupSnapshot] = useState<GroupThreadSnapshot | null>(null);
  const [peers, setPeers] = useState<Bot[]>([]);
  const [draft, setDraft] = useState("");
  const [editMessageId, setEditMessageId] = useState<string | null>(null);
  /** Recado que o próximo envio responde. O bot recebe o trecho citado junto. */
  const [replyTo, setReplyTo] = useState<ThreadMessage | null>(null);
  const [caret, setCaret] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [panel, setPanel] = useState<Panel>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [feedStatus, setFeedStatus] = useState<LiveFeedStatus>("connecting");
  const [workerAlive, setWorkerAlive] = useState<boolean | null>(null);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [groupRoutines, setGroupRoutines] = useState<Routine[]>([]);
  const [skills, setSkills] = useState<CapabilityInstall[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [groupComputerMenu, setGroupComputerMenu] = useState(false);
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  /** Máquina e celular abrem sobre o app, como plugins — não como página à parte. */
  const [settingsModal, setSettingsModal] = useState<SettingsPage | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [booting, setBooting] = useState(false);
  const [routineDraft, setRoutineDraft] = useState({
    id: "",
    name: "",
    prompt: "",
    schedule: defaultCronPreset(),
    active: true,
  });
  const [routineSaving, setRoutineSaving] = useState(false);
  const [screenUrl, setScreenUrl] = useState<string | null>(null);
  const [computerOpen, setComputerOpen] = useState(false);
  const [computerMenu, setComputerMenu] = useState(false);
  const [trackpadMode, setTrackpadMode] = useState(false);
  const [usage, setUsage] = useState<{
    inputTokens: number;
    outputTokens: number;
    runs: number;
  } | null>(null);
  const [billing, setBilling] = useState<BillingSnapshot | null>(null);
  const [billingBusy, setBillingBusy] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{
    message: string;
    cause: unknown;
  } | null>(null);
  const autoBooted = useRef<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  /** Quando o último evento do stream chegou — o vigia da conversa olha para isto. */
  const lastThreadEventAt = useRef(0);
  const [followThread, setFollowThread] = useState(true);
  /** Última posição lida: é a diferença que diz se a pessoa subiu ou desceu. */
  const lastScrollTop = useRef(0);
  const [queued, setQueued] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [composerMenu, setComposerMenu] = useState(false);
  const [teaching, setTeaching] = useState(false);
  const [teachNotes, setTeachNotes] = useState("");
  const [teachBusy, setTeachBusy] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [transcribing, setTranscribing] = useState<TranscribeStatus>({
    state: "idle",
  });
  const recorderRef = useRef<ReturnType<typeof createVoiceRecorder> | null>(null);
  const canRecord = voiceSupported();

  /** Enquanto grava, o contador anda: é ele que mostra que o microfone está aberto. */
  useEffect(() => {
    if (!dictating) return;
    const started = Date.now();
    setRecordSeconds(0);
    const timer = window.setInterval(() => {
      setRecordSeconds((Date.now() - started) / 1000);
    }, 200);
    return () => window.clearInterval(timer);
  }, [dictating]);

  useEffect(() => () => recorderRef.current?.cancel(), []);

  async function attachFiles(files: FileList | File[]) {
    const bot = active;
    if (!bot) return;
    setActionError(null);
    setAttaching(true);
    try {
      for (const file of Array.from(files).slice(0, 8)) {
        if (attachmentTooBig(file.size)) {
          setActionError({
            message: `${file.name} passa de 25 MB.`,
            cause: null,
          });
          continue;
        }
        const stored = await uploadAttachment(bot.id, file);
        setAttachments((current) => [...current, stored]);
      }
    } catch (err) {
      setActionFailure(err, "Não foi possível anexar");
    } finally {
      setAttaching(false);
    }
  }

  async function startRecording() {
    const bot = active;
    if (!bot || !canRecord) return;
    const recorder = createVoiceRecorder();
    recorderRef.current = recorder;
    setActionError(null);
    try {
      await recorder.start();
      setDictating(true);
    } catch {
      recorderRef.current = null;
      setActionError({
        message: "O microfone não abriu. Libere o acesso ao microfone e tente de novo.",
        cause: null,
      });
    }
  }

  function cancelRecording() {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setDictating(false);
  }

  /** Para de gravar e anexa a nota de voz ao recado. */
  async function finishRecording() {
    const recorder = recorderRef.current;
    const bot = active;
    recorderRef.current = null;
    setDictating(false);
    if (!recorder || !bot) return;
    const taken = await recorder.stop();
    if (!taken) return;
    setAttaching(true);
    try {
      const name = `recado-de-voz.${extensionFor(taken.mimeType)}`;
      const stored = await uploadAttachment(bot.id, taken.blob, name);
      setAttachments((current) => [...current, stored]);
    } catch (err) {
      setActionFailure(err, "Não foi possível enviar o áudio");
      return;
    } finally {
      setAttaching(false);
    }

    // A transcrição corre por fora: o áudio já está anexado e o envio nunca espera por ela.
    if (!transcriptionSupported()) return;
    const { transcribe } = await import("../lib/transcribe");
    const text = await transcribe(taken.blob, {
      language: navigator.language?.split("-")[0] ?? "pt",
      onStatus: setTranscribing,
    });
    // Se o recado já foi embora, o texto perdeu a hora; e o que a pessoa digitou no
    // meio tempo continua onde estava.
    if (text) setDraft((current) => (current.trim() ? `${current.trim()} ${text}` : text));
  }

  function setActionFailure(error: unknown, fallback: string) {
    // "Failed to fetch" é o que o navegador diz quando o Quibt caiu ou a rede sumiu;
    // na tela isso vira uma frase que a pessoa consegue agir em cima.
    setActionError({ message: errorMessage(error, fallback), cause: error });
  }

  useEffect(() => {
    if (!accountOpen) return;
    rpc.billing
      .get()
      .then(setBilling)
      .catch(() => setBilling(null));
  }, [accountOpen]);

  async function openBillingUrl(load: () => Promise<{ url: string }>) {
    setBillingBusy(true);
    setBillingError(null);
    try {
      const { url } = await load();
      window.open(url, "_blank", "noopener");
    } catch (err) {
      setBillingError(err instanceof Error ? err.message : "Não foi possível abrir o Stripe.");
    } finally {
      setBillingBusy(false);
    }
  }

  const onInbox = !botId && !groupId;
  const activeGroup = groupId ? (groups.find((g) => g.id === groupId) ?? null) : null;
  const active = botId ? (bots.find((b) => b.id === botId) ?? null) : null;
  // The bots poller and the live-feed callbacks capture stale closures; they read the
  // current route from this ref so a deleted or switched bot never acts on old params.
  const paramsRef = useRef({ botId, groupId });
  paramsRef.current = { botId, groupId };

  async function refreshBots() {
    const list = await rpc.bots.list();
    setBots(list);
    if (list.length === 0) {
      navigate("/onboarding", { replace: true });
      return list;
    }
    const current = paramsRef.current;
    if (current.groupId) return list;
    if (current.botId && !list.some((bot) => bot.id === current.botId)) {
      navigate("/app", { replace: true });
    }
    return list;
  }

  async function refreshGroups() {
    const list = await rpc.botGroups.list().catch(() => [] as BotGroup[]);
    setGroups(list);
    return list;
  }

  async function refreshGroupThread(id: string) {
    const snap = await rpc.botGroups.thread({ groupId: id });
    // A slow response for a group the user already left must not overwrite the current one.
    if (paramsRef.current.groupId !== id) return snap;
    setGroupSnapshot(snap);
    return snap;
  }

  async function refreshGroupRoutines(id: string) {
    const list = await rpc.routines.list({ groupId: id }).catch(() => [] as Routine[]);
    setGroupRoutines(list);
    return list;
  }

  async function refreshComposerRefs() {
    const [skillRows, connectionRows] = await Promise.all([
      rpc.capabilities.list().catch(() => [] as CapabilityInstall[]),
      rpc.connections.list().catch(() => [] as Connection[]),
    ]);
    setSkills(skillRows.filter((row) => row.kind === "skill"));
    setConnections(connectionRows.filter((row) => row.status === "connected"));
  }

  async function refreshThread(id: string) {
    const [snap, r] = await Promise.all([
      rpc.threads.get({ botId: id }),
      rpc.routines.list({ botId: id }),
    ]);
    if (paramsRef.current.botId !== id) return snap;
    setSnapshot(snap);
    setComputer(snap.computer);
    setRoutines(r);
    if (
      shouldFetchScreenUrl({
        screenUrl: snap.computer.screenUrl,
        state: snap.computer.state,
        controlHolder: snap.computer.controlHolder,
        open: panel === "computer" || computerOpen,
      })
    ) {
      const screen = await rpc.computer.screenUrl({ botId: id }).catch(() => ({ url: null }));
      if (paramsRef.current.botId === id) setScreenUrl(screen.url);
    } else {
      setScreenUrl(snap.computer.screenUrl ?? null);
    }
    return snap;
  }

  /**
   * A webhook activity row's "Abrir no chat": closes the panel, refreshes the bot's
   * own thread, and scrolls to the earliest message carrying that run — a webhook's
   * bot is always the panel's own bot, so no navigation is needed. If no message
   * carries that run yet (still queued, or nothing written), the chat still opens
   * with no error; it simply has nothing to scroll to.
   */
  async function openWebhookRun(runId: string) {
    setPanel(null);
    if (!active) return;
    await refreshThread(active.id).catch(() => undefined);
    requestAnimationFrame(() => {
      threadRef.current
        ?.querySelector<HTMLElement>(`[data-run-id="${runId}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  useEffect(() => {
    void refreshComposerRefs();
    void refreshGroups().then((list) => {
      if (groupId && !list.some((group) => group.id === groupId)) {
        navigate("/app", { replace: true });
      }
    });
    // O aviso de worker parado pega carona neste poll: `me` só é perguntado de tempos em
    // tempos (a cadência do batimento), nunca a cada volta.
    const refreshWorkerAlive = workerAliveRefresher(() => rpc.me(), setWorkerAlive);
    const stop = startPolling(
      async () => {
        if (document.visibilityState === "hidden") return;
        await refreshBots();
        await refreshWorkerAlive();
      },
      4000,
      { immediate: true },
    );
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshBots().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if (!active) {
      setPeers([]);
      return;
    }
    void rpc.peers
      .list({ botId: active.id })
      .then(setPeers)
      .catch(() => setPeers([]));
  }, [active?.id]);

  useEffect(() => {
    setGroupComputerMenu(false);
    if (groupId) {
      void refreshGroupRoutines(groupId);
      return;
    }
    setGroupRoutines([]);
    setPanel((current) => (current === "members" ? null : current));
  }, [groupId]);

  useEffect(() => {
    if (!groupId) {
      setGroupSnapshot(null);
      return;
    }
    const reload = async () => {
      await refreshGroupThread(groupId).catch(() => undefined);
    };
    // Reconnects with backoff when the stream drops and polls in between, so a laptop
    // waking from sleep or a server restart never leaves the group thread frozen.
    const feed = startLiveFeed({
      onStatus: setFeedStatus,
      connect: async (signal, opened) => {
        const snap = await refreshGroupThread(groupId);
        if (signal.aborted) return;
        const events = await rpc.botGroups.subscribe(
          { groupId, cursor: snap.cursor ?? -1 },
          { signal },
        );
        opened();
        for await (const event of events) {
          if (signal.aborted) break;
          applyGroupThreadEvent(event, setGroupSnapshot);
          if (threadEventNeedsSnapshotRefresh(event.type)) {
            void reload();
          }
        }
      },
      refresh: reload,
    });
    return () => feed.stop();
  }, [groupId]);

  useEffect(() => {
    if (!active) return;
    const botId = active.id;
    setFeedStatus("connecting");
    const feed = startLiveFeed({
      onStatus: setFeedStatus,
      connect: async (signal, opened) => {
        const snap = await refreshThread(botId);
        if (signal.aborted) return;
        const events = await rpc.threads.subscribe(
          { botId, cursor: snap.cursor ?? -1 },
          { signal },
        );
        opened();
        for await (const event of events) {
          if (signal.aborted) break;
          lastThreadEventAt.current = Date.now();
          applyThreadEvent(event, setSnapshot, setComputer);
          if (event.type === "run.failed") {
            const raw = String(event.payload.error ?? "");
            if (raw)
              setActionError({ message: errorMessage(new Error(raw), raw), cause: new Error(raw) });
          }
          if (
            event.type === "bot.spawned" ||
            event.type === "bot.deleted" ||
            event.type === "run.started" ||
            event.type === "run.completed" ||
            event.type === "computer.status"
          ) {
            void refreshBots().catch(() => undefined);
          }
          if (event.type === "thread.message.created") {
            const blocks = (event.payload.blocks as Array<{ kind?: string }>) ?? [];
            if (blocks.some((block) => block.kind === "child_bot")) {
              void refreshBots().catch(() => undefined);
            }
          }
          if (threadEventNeedsSnapshotRefresh(event.type)) {
            void refreshThread(botId).catch(() => undefined);
          }
        }
      },
      refresh: async () => {
        await refreshThread(botId).catch(() => undefined);
      },
    });
    return () => feed.stop();
  }, [active?.id]);

  const working = activeGroup
    ? (groupSnapshot?.runs ?? []).some((run) => ACTIVE_RUN.includes(run.status))
    : Boolean(snapshot?.run && ACTIVE_RUN.includes(snapshot.run.status));

  async function stopWorkingRuns() {
    const botIds = activeGroup
      ? [
          ...new Set(
            (groupSnapshot?.runs ?? [])
              .filter((run) => ACTIVE_RUN.includes(run.status))
              .map((run) => run.botId),
          ),
        ]
      : active
        ? [active.id]
        : [];
    if (botIds.length === 0 || stopping) return;
    setActionError(null);
    setStopping(true);
    try {
      await Promise.all(botIds.map((id) => rpc.threads.stop({ botId: id })));
      if (activeGroup) {
        const stopped = new Set(botIds);
        setGroupSnapshot((current) =>
          current
            ? {
                ...current,
                runs: current.runs.filter((run) => !stopped.has(run.botId)),
                messages: current.messages.filter((message) => !message.id.startsWith("progress:")),
              }
            : current,
        );
        await refreshGroupThread(activeGroup.id).catch(() => undefined);
      } else if (active) {
        setSnapshot((current) =>
          current
            ? {
                ...current,
                run: null,
                messages: current.messages.filter((message) => !message.id.startsWith("progress:")),
              }
            : current,
        );
        await refreshThread(active.id).catch(() => undefined);
      }
    } catch (err) {
      setActionFailure(err, "Não foi possível parar");
    } finally {
      setStopping(false);
    }
  }

  /**
   * Rede de segurança do stream. Um stream pode morrer sem avisar (o proxy recicla, o
   * container da API reinicia, o notebook dorme) e a conversa fica parada: a aprovação
   * que o bot pediu só aparecia quando a pessoa saía e voltava. Enquanto o bot trabalha,
   * se nada chega por alguns segundos, buscamos o retrato de novo — e também ao voltar
   * para a janela.
   */
  const workingRef = useRef(working);
  workingRef.current = working;
  useEffect(() => {
    if (!active) return;
    const botId = active.id;
    const tick = window.setInterval(() => {
      if (!workingRef.current) return;
      if (Date.now() - lastThreadEventAt.current < 8_000) return;
      void refreshThread(botId).catch(() => undefined);
    }, 4_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void refreshThread(botId).catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [active?.id]);

  const mention = useMemo(
    () => (mentionDismissed ? null : activeComposerToken(draft, caret)),
    [mentionDismissed, draft, caret],
  );

  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    if (mention?.kind === "skill") {
      return skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        title: "Skill",
        kind: "skill" as const,
      }));
    }
    const addressable: MentionCandidate[] = [
      ...peers.map((peer) => ({
        id: peer.id,
        name: peer.name,
        title: peer.title || "Bot",
        color: peer.color,
        shape: peer.shape,
        kind: "bot" as const,
      })),
      ...groups
        .filter((group) => group.id !== activeGroup?.id)
        .map((group) => ({
          id: group.id,
          name: group.name,
          title: "Grupo",
          kind: "group" as const,
        })),
      ...(activeGroup ? groupRoutines : routines).map((routine) => ({
        id: routine.id,
        name: routine.name,
        title: routine.active ? formatCron(routine.cron) : "Pausada",
        kind: "routine" as const,
      })),
      ...connections.map((connection) => ({
        id: connection.id,
        name: connection.displayName || connection.provider,
        title: "Plugin",
        kind: "connector" as const,
      })),
    ];
    if (activeGroup) {
      return [
        ...activeGroup.members.map((member) => ({
          id: member.id,
          name: member.name,
          title: member.title,
          color: member.color,
          shape: member.shape,
          kind: "bot" as const,
        })),
        {
          id: "everyone",
          name: "everyone",
          title: "Acorda todo o grupo",
          everyone: true,
          kind: "everyone" as const,
        },
        ...addressable.filter((candidate) => candidate.kind !== "bot"),
      ];
    }
    return addressable;
  }, [mention?.kind, skills, peers, groups, activeGroup, groupRoutines, routines, connections]);

  const mentionMatches = useMemo(() => {
    if (!mention) return [];
    return mentionCandidates
      .filter((candidate) => matchesMention(candidate.name, mention.query))
      .slice(0, 8);
  }, [mention, mentionCandidates]);

  useEffect(() => {
    setMentionIndex(0);
  }, [mention?.query, mention?.kind]);

  const threadMessages = activeGroup ? (groupSnapshot?.messages ?? []) : (snapshot?.messages ?? []);

  /**
   * "trabalhando…" é a espera antes da primeira palavra. Assim que o bot escreve alguma
   * coisa deste turno, quem mostra que ele ainda está trabalhando é a própria resposta —
   * os dois juntos eram dois avisos para o mesmo estado.
   */
  const lastMessage = threadMessages[threadMessages.length - 1];
  const answeringNow = activeGroup
    ? Boolean(lastMessage && isAnsweringMessage(lastMessage))
    : Boolean(
        snapshot?.run &&
          threadMessages.some(
            (message) => message.runId === snapshot.run?.id && isAnsweringMessage(message),
          ),
      );
  const awaitingFirstWord = working && !answeringNow;
  const bursts = useMemo(() => {
    const authorsFallback = active?.id;
    return multiAgentBursts(
      threadMessages.map((message) => ({
        id: message.id,
        role: message.role,
        authorId:
          message.authorBotId ??
          message.fromBotId ??
          (message.role === "bot" ? authorsFallback : null),
      })),
    );
  }, [threadMessages, active?.id]);
  const burstByLastId = useMemo(
    () => Object.fromEntries(bursts.map((burst) => [burst.lastMessageId, burst])),
    [bursts],
  );
  const authorLookup = useMemo(() => {
    const list = activeGroup ? activeGroup.members : bots;
    return Object.fromEntries(list.map((bot) => [bot.id, bot]));
  }, [activeGroup, bots]);
  const stamps = useMemo(() => dayStamps(threadMessages), [threadMessages]);
  // One pass per thread instead of two O(n) scans per message per render.
  const versionIndex = useMemo(() => versionsByParent(threadMessages), [threadMessages]);

  function acceptMention(candidate: MentionCandidate) {
    const next =
      mention?.kind === "skill" || candidate.kind === "skill"
        ? insertSlash(draft, caret, candidate.name)
        : insertMention(draft, caret, candidate.name);
    setDraft(next.text);
    setCaret(next.caret);
    setMentionDismissed(true);
    requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(next.caret, next.caret);
    });
  }

  async function sendText(text: string, editing: string | null = null) {
    if (activeGroup) {
      const mentioned = mentionedTargets(text, activeGroup.members);
      setActionError(null);
      try {
        await rpc.botGroups.send({
          groupId: activeGroup.id,
          text,
          clientNonce: newClientNonce(),
          mentionBotIds: mentioned.length ? mentioned.map((member) => member.id) : undefined,
        });
        await refreshGroupThread(activeGroup.id).catch(() => undefined);
      } catch (err) {
        setDraft(text);
        setActionFailure(err, "Não foi possível enviar");
      }
      return;
    }
    if (!active) return;
    const mentioned = mentionedTargets(text, peers);
    setActionError(null);
    try {
      if (editing) {
        await rpc.threads.edit({ botId: active.id, messageId: editing, text });
      } else {
        await rpc.threads.send({
          botId: active.id,
          text,
          clientNonce: newClientNonce(),
          mentionBotIds: mentioned.length ? mentioned.map((peer) => peer.id) : undefined,
          replyToId: replyTo?.id,
          attachments: attachments.length ? attachments.map((file) => file.id) : undefined,
        });
        setReplyTo(null);
        setAttachments([]);
      }
    } catch (err) {
      setDraft(text);
      setEditMessageId(editing);
      setActionFailure(err, "Não foi possível enviar");
      return;
    }
    await refreshThread(active.id).catch(() => undefined);
  }

  /** Trecho do recado citado, para desenhar a linha acima da bolha. */
  function quotedTextFor(replyToId?: string): string | undefined {
    if (!replyToId) return undefined;
    const source = threadMessages.find((row) => row.id === replyToId);
    if (!source) return undefined;
    const text = source.blocks
      .map((block) => ("text" in block && block.text ? block.text : ""))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return undefined;
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  }

  async function send() {
    // Um anexo sozinho já é um recado: a nota de voz vai sem texto nenhum.
    if (!draft.trim() && !attachments.length) return;
    const text = draft.trim() ? draft : attachments.map((file) => file.name).join(", ");
    if (working && !editMessageId) {
      setQueued(text);
      setDraft("");
      setMentionDismissed(false);
      return;
    }
    const editing = editMessageId;
    setDraft("");
    setEditMessageId(null);
    setMentionDismissed(false);
    await sendText(text, editing);
  }

  async function sendQueued(text: string) {
    setDraft("");
    await sendText(text);
  }

  function onComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (mentionMatches.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionMatches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        acceptMention(mentionMatches[mentionIndex] ?? mentionMatches[0]!);
        return;
      }
      if (event.key === "Escape") {
        setMentionDismissed(true);
        return;
      }
    }
    if (event.key === "ArrowUp" && !draft.trim() && lastUserText && !working) {
      event.preventDefault();
      setDraft(lastUserText.text);
      setEditMessageId(lastUserText.id);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  async function createGroup(input: { name: string; botIds: string[] }) {
    setActionError(null);
    try {
      const group = await rpc.botGroups.create(input);
      setQuery("");
      await refreshGroups();
      setPanel(null);
      navigate(`/app/g/${group.id}`);
    } catch (err) {
      setActionFailure(err, "Não foi possível criar o grupo");
    }
  }

  async function createBot(input: {
    name: string;
    title: string;
    description: string;
    color: string;
    shape: string;
  }) {
    setActionError(null);
    try {
      const bot = await rpc.bots.create({
        name: input.name.trim(),
        title: input.title,
        description: input.description,
        instructions: input.description,
        notifyOnFinish: true,
        color: input.color,
        shape: input.shape,
      });
      await refreshBots();
      navigate(`/app/${bot.id}`);
      setPanel(null);
    } catch (err) {
      setActionFailure(err, "Não foi possível criar o bot");
    }
  }

  async function bootComputer({
    takeControl,
    overlay,
    force = false,
  }: {
    takeControl: boolean;
    overlay: boolean;
    force?: boolean;
  }) {
    if (!active) return;
    // An explicit "open the computer" is the user asking again: give the screen a fresh
    // reconnect budget instead of leaving it on the give-up message.
    screenRetries.current = 0;
    setScreenLost(false);
    const needsBoot = force || computer?.state !== "running" || !screenUrl;
    if (overlay && needsBoot) setBooting(true);
    try {
      if (needsBoot) await rpc.computer.boot({ botId: active.id });
      if (takeControl) await rpc.computer.takeover({ botId: active.id });
      await refreshThread(active.id);
    } catch (err) {
      setActionFailure(err, "Não foi possível ligar o computador");
    } finally {
      setBooting(false);
    }
  }

  useEffect(() => {
    if (panel !== "computer") {
      autoBooted.current = null;
      return;
    }
    if (!active) return;
    if (computer?.state === "booting" || computer?.state === "suspended") return;
    if (autoBooted.current === active.id && computer?.state === "running" && screenUrl) return;
    autoBooted.current = active.id;
    void bootComputer({
      takeControl: false,
      overlay: computer?.state !== "running",
      force: true,
    });
  }, [panel, active?.id, computer?.state, screenUrl]);

  useEffect(() => {
    setComputerOpen(false);
    // A different bot means a different screen: the previous one's reconnect budget and
    // give-up message must not follow it.
    screenRetries.current = 0;
    setScreenLost(false);
  }, [active?.id]);

  function closeComputerOverlay() {
    setComputerOpen(false);
    setPanel((current) => (current === "computer" ? null : current));
  }

  useEffect(() => {
    if (!computerOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") closeComputerOverlay();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [computerOpen]);

  useEffect(() => {
    if ((panel !== "computer" && !computerOpen) || !active || computer?.state !== "running") return;
    if (computer?.controlHolder !== "user") return;
    const botId = active.id;
    // Aba escondida não é gente na frente do computador: o navegador segue rodando o timer
    // (mais devagar) e a batida dizia "ainda estou aqui" de uma tela que ninguém olha.
    // Junto com a regra do servidor — só tecla ou clique renova —, quem sai para o almoço
    // devolve o computador ao bot no prazo, como a doc promete.
    const ping = () => {
      if (document.visibilityState !== "visible") return;
      // O que a pessoa digita dentro do noVNC não passa pela nossa API: vai direto pelo
      // WebSocket do quadro. Então o prazo do controle só anda enquanto o teclado está
      // mesmo lá dentro — é a prova que o servidor não tem como colher sozinho.
      const atScreen =
        document.hasFocus() &&
        screenFrame.current !== null &&
        document.activeElement === screenFrame.current;
      void rpc.computer
        .heartbeat({ botId, atScreen })
        .then((answer) => {
          // O prazo novo, quando houve, mantém o "controle até HH:mm" andando.
          setComputer((current) =>
            current?.botId === botId
              ? withControlLease(current, answer.controlLeaseExpiresAt)
              : current,
          );
        })
        .catch(() => undefined);
    };
    ping();
    const timer = window.setInterval(ping, 60_000);
    const onVisible = () => ping();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [panel, computerOpen, active?.id, computer?.state]);

  async function openComputer() {
    if (!active) return;
    await bootComputer({
      takeControl: false,
      overlay: computer?.state !== "running",
      force: computer?.state !== "running",
    });
    setComputerOpen(true);
  }

  async function takeOverComputer() {
    if (!active) return;
    await bootComputer({
      takeControl: true,
      overlay: computer?.state !== "running",
    });
    setComputerOpen(true);
    await refreshThread(active.id);
  }

  /**
   * Ensinar uma tarefa: assume o computador, abre a tela e marca o ponto de partida.
   * Sem o controle não há o que ensinar — quem está com o mouse é o bot.
   */
  async function startTeaching() {
    if (!active) return;
    setTeachBusy(true);
    try {
      if (computer?.controlHolder !== "user") await takeOverComputer();
      await rpc.computer.teachStart({ botId: active.id });
      setTeachNotes("");
      setTeaching(true);
      setComputerOpen(true);
    } catch (cause) {
      setActionFailure(cause, "Não foi possível começar a ensinar.");
    } finally {
      setTeachBusy(false);
    }
  }

  /**
   * Fecha a lição: colhe o que aconteceu e devolve o texto para o campo de mensagem, em
   * vez de mandar direto. A pessoa lê, corrige o que a captura entendeu torto e só então
   * envia — é ela quem decide o que o bot vai guardar como método.
   */
  async function finishTeaching() {
    if (!active) return;
    setTeachBusy(true);
    try {
      const capture = await rpc.computer.teachCapture({ botId: active.id });
      const prompt = lessonPrompt(teachNotes, { ...capture, windows: [] });
      setTeaching(false);
      setComputerOpen(false);
      setDraft(prompt);
      setCaret(prompt.length);
      if (capture.empty) {
        setActionError({
          message:
            "Não vi páginas, comandos nem arquivos nessa sessão. Descreva os passos você mesmo antes de enviar.",
          cause: null,
        });
      }
      composerRef.current?.focus();
    } catch (cause) {
      setActionFailure(cause, "Não foi possível fechar a lição.");
    } finally {
      setTeachBusy(false);
    }
  }

  async function releaseComputer() {
    if (!active) return;
    await rpc.computer.release({ botId: active.id }).catch(() => undefined);
    setComputerOpen(false);
    await refreshThread(active.id);
  }

  const embeddedScreenUrl = embeddableScreenUrl(screenUrl);
  // Every refresh asks the API for a freshly signed screen URL. Writing it into the iframe
  // `src` reloads noVNC and drops the session the user is in the middle of, so the URL the
  // iframe shows is pinned while it is mounted: the signature only guards the handshake.
  // A new URL is taken when the iframe is not mounted (a (re)mount needs a capability that
  // will still be valid) or when it points at a different screen.
  const [pinnedScreenUrl, setPinnedScreenUrl] = useState<string | null>(null);
  const pinnedScreenUrlRef = useRef<string | null>(null);
  pinnedScreenUrlRef.current = pinnedScreenUrl;
  const screenFrame = useRef<HTMLIFrameElement | null>(null);
  const screenFrameMountedAt = useRef<number | null>(null);
  const screenRenewedAt = useRef(0);
  const screenRetries = useRef(0);
  const screenRetryTimer = useRef<number | null>(null);
  const handledScreenDrop = useRef(0);
  // Bumped once per reconnect attempt so the pin below knows the session died.
  const [screenDrop, setScreenDrop] = useState(0);
  const [screenLost, setScreenLost] = useState(false);
  const takeoverRequested = snapshot?.run?.status === "waiting_takeover";
  const screenVisible = (panel === "computer" || computerOpen) && computer?.state === "running";
  // `controlHolder` é o campo do banco: vale "user" para a workspace inteira enquanto
  // alguém tiver o lease. A URL da tela só vem para quem o tem — é ela que diz "é meu".
  const holdsControl = holdsComputerControl({
    controlHolder: computer?.controlHolder,
    screenUrl,
  });
  const othersControl = othersHoldControl({
    controlHolder: computer?.controlHolder,
    screenUrl,
    state: computer?.state,
  });
  const attachScreenFrame = useCallback((node: HTMLIFrameElement | null) => {
    screenFrame.current = node;
    screenFrameMountedAt.current = node ? Date.now() : null;
  }, []);

  // noVNC never re-handshakes on its own: a network blip, a laptop waking up or a sandbox
  // restart leave the screen frozen until the panel is closed and opened again. The embed
  // page reports the drop and we remount it with a capability minted for the occasion.
  useEffect(() => {
    if (!screenVisible) return;
    const onMessage = (event: MessageEvent) => {
      const kind = screenFrameEvent(
        event,
        screenFrame.current?.contentWindow,
        window.location.origin,
      );
      if (!kind) return;
      if (kind === "connected") {
        screenRetries.current = 0;
        setScreenLost(false);
        return;
      }
      const plan = planScreenReconnect(screenRetries.current);
      if (!plan.retry) {
        setScreenLost(true);
        return;
      }
      screenRetries.current = plan.nextAttempt;
      if (screenRetryTimer.current !== null) window.clearTimeout(screenRetryTimer.current);
      screenRetryTimer.current = window.setTimeout(() => {
        screenRetryTimer.current = null;
        setScreenDrop((drop) => drop + 1);
      }, plan.delayMs);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      if (screenRetryTimer.current !== null) {
        window.clearTimeout(screenRetryTimer.current);
        screenRetryTimer.current = null;
      }
    };
  }, [screenVisible]);

  useEffect(() => {
    if (!screenVisible) {
      screenFrameMountedAt.current = null;
      screenRetries.current = 0;
      handledScreenDrop.current = screenDrop;
      setPinnedScreenUrl(null);
      setScreenLost(false);
      return;
    }
    // Gave up: take the frozen frame down and stop remounting until the user asks again,
    // otherwise the retry budget would be spent on a loop the user cannot see.
    if (screenLost) {
      screenFrameMountedAt.current = null;
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
      mountedAt: screenFrameMountedAt.current,
      now,
      disconnected: dropped,
    });
    setPinnedScreenUrl(decision.url);
    // Nothing safe to mount: ask for a new capability. A plain renewal is throttled so a
    // clock skew on the server cannot turn this into a refresh loop; a reconnect is not,
    // because the backoff above already bounds it and the user is staring at a dead screen.
    const renewing = decision.action === "renew" && now - screenRenewedAt.current > 5_000;
    if ((renewing || decision.action === "reconnect") && active) {
      screenRenewedAt.current = now;
      void refreshThread(active.id).catch(() => undefined);
    }
  }, [screenVisible, embeddedScreenUrl, active?.id, screenDrop, screenLost, pinnedScreenUrl]);

  // Sem o lease não há stream para ter caído: "a tela caiu" é coisa do iframe, e o iframe
  // só existe com o controle. Liberar (ou perder) o controle limpa o aviso — senão ele
  // tapava o retrato que o poll começa a buscar, e ainda pagava um screenshot por tick.
  useEffect(() => {
    if (holdsControl) return;
    screenRetries.current = 0;
    setScreenLost(false);
  }, [holdsControl]);

  /**
   * Sem o controle não há stream (a capacidade do noVNC é interativa, só vai para quem
   * tem a posse), mas há a tela: um retrato a cada 3 s, o TTL do cache da API, mostrado
   * no lugar da ilustração de mesa enquanto o bot trabalha. Quem pede "abre o site e
   * manda print" vê o site abrindo, em vez de um desenho parado que parece travamento.
   * O poll para com o painel fechado, a aba escondida, o controle na mão desta pessoa (o
   * iframe assume) ou o computador desligado. Uma falha não apaga nada: o último retrato
   * fica, envelhecendo no selo, com "sem prévia · tentando de novo" por cima, e só some
   * depois de um minuto sem retrato novo; o poll tenta de novo com espera crescente.
   */
  const [preview, setPreview] = useState<PreviewFrame | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [previewNow, setPreviewNow] = useState(() => Date.now());
  const [documentHidden, setDocumentHidden] = useState(
    () => typeof document !== "undefined" && document.visibilityState === "hidden",
  );
  useEffect(() => {
    const onVisibility = () => setDocumentHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  const wantsPreview =
    Boolean(active) &&
    shouldPollPreview({
      state: computer?.state,
      controlHolder: computer?.controlHolder,
      screenUrl,
      // Como na referência, o próprio card da conversa mostra um retrato vivo antes de
      // a pessoa assumir. O stream interativo continua restrito ao overlay e ao lease.
      shown: panel === "computer" || computerOpen || takeoverRequested,
      hidden: documentHidden,
      streaming: pinnedScreenUrl !== null,
      screenLost,
    });
  const previewBotId = active?.id ?? null;
  useEffect(() => {
    if (!wantsPreview || !previewBotId) {
      setPreview(null);
      setPreviewFailed(false);
      return;
    }
    const poller = createPreviewPoller({
      fetch: () => rpc.computer.preview({ botId: previewBotId }),
      setTimeout: (callback, ms) => window.setTimeout(callback, ms),
      clearTimeout: (id) => window.clearTimeout(id),
      onFrame: (frame) => {
        setPreview(frame);
        setPreviewFailed(false);
      },
      onFailure: () => setPreviewFailed(true),
    });
    return () => poller.stop();
  }, [wantsPreview, previewBotId]);
  // O selo "há Ns" anda a cada segundo, independente de quando chega o próximo retrato.
  useEffect(() => {
    if (!preview) return;
    setPreviewNow(Date.now());
    const timer = window.setInterval(() => setPreviewNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [preview]);
  const previewAge = preview ? previewAgeMs(preview, previewNow) : null;
  const previewLabel = previewAge !== null ? previewAgeLabel(previewAge) : null;
  // Um retrato de até um minuto ainda é a tela (velha, e o selo diz quanto); depois disso
  // volta a ilustração, para ninguém tomar uma tela parada por atual.
  const previewShown =
    preview && previewAge !== null && !previewIsStale(previewAge) ? preview : null;

  async function pasteToComputer() {
    if (!active) return;
    const text = await navigator.clipboard.readText().catch(() => "");
    if (!text) return;
    await rpc.computer.input({
      botId: active.id,
      kind: "clipboard",
      payload: { text },
    });
  }

  /**
   * Modo trackpad: o mouse fica preso na área da tela (pointer lock) e manda o
   * DESLOCAMENTO, como um trackpad de verdade; soltar sem arrastar é clique (direito com
   * o botão direito) e o teclado vai para o computador do bot. Sem o controle nada disso
   * chega, então entrar no modo assume o controle primeiro.
   */
  const trackpadSurface = useRef<HTMLDivElement | null>(null);
  const trackpadBotId = useRef<string | null>(null);
  trackpadBotId.current = active?.id ?? null;
  const trackpadMoved = useRef(0);
  const trackpadMoves = useMemo(
    () =>
      createPointerMoveCoalescer(({ x, y }) => {
        const botId = trackpadBotId.current;
        if (!botId) return;
        void rpc.computer.input({
          botId,
          kind: "pointer",
          payload: { x, y, type: "moveRelative" },
        });
      }),
    [],
  );
  const trackpadLive = trackpadMode && Boolean(active) && computer?.controlHolder === "user";

  async function toggleTrackpadMode() {
    if (trackpadMode) {
      setTrackpadMode(false);
      if (document.pointerLockElement) document.exitPointerLock();
      return;
    }
    try {
      if (computer?.controlHolder !== "user") await takeOverComputer();
      setTrackpadMode(true);
    } catch (cause) {
      setActionFailure(cause, "Não foi possível assumir o computador.");
    }
  }

  useEffect(() => {
    if (!trackpadMode) return;
    trackpadSurface.current?.focus();
    // Esc solta o mouse no navegador — e é a saída natural do modo trackpad.
    const onLockChange = () => {
      if (!document.pointerLockElement) setTrackpadMode(false);
    };
    document.addEventListener("pointerlockchange", onLockChange);
    return () => {
      document.removeEventListener("pointerlockchange", onLockChange);
      trackpadMoves.cancel();
      if (document.pointerLockElement) document.exitPointerLock();
    };
  }, [trackpadMode, trackpadMoves]);

  function onTrackpadPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!trackpadMode) return;
    event.preventDefault();
    trackpadMoved.current = 0;
    const surface = trackpadSurface.current;
    surface?.focus();
    if (surface && document.pointerLockElement !== surface) {
      surface.requestPointerLock?.();
    }
  }

  function onTrackpadMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!trackpadLive) return;
    trackpadMoved.current += Math.abs(event.movementX) + Math.abs(event.movementY);
    trackpadMoves.add({ x: event.movementX, y: event.movementY });
  }

  function onTrackpadPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (!trackpadLive || !active) return;
    trackpadMoves.flush();
    if (trackpadReleaseAction(trackpadMoved.current) !== "click") return;
    void rpc.computer.input({
      botId: active.id,
      kind: "pointer",
      payload: { x: 0, y: 0, type: "tap", button: event.button === 2 ? "right" : "left" },
    });
  }

  function onTrackpadKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!trackpadLive || !active) return;
    const input = trackpadKeyInput(event);
    if (!input) return;
    event.preventDefault();
    void rpc.computer.input({
      botId: active.id,
      kind: input.kind,
      payload:
        input.kind === "key"
          ? { key: input.key, modifiers: input.modifiers }
          : { text: input.text },
    });
  }

  const userName = session.data?.user.name ?? "Você";
  const userEmail = session.data?.user.email;
  const userImage = session.data?.user.image ?? null;
  const threadOpen = Boolean(active || activeGroup);
  const lastUserText = useMemo(() => {
    for (let i = threadMessages.length - 1; i >= 0; i -= 1) {
      const message = threadMessages[i];
      if (message?.role !== "user") continue;
      const text = message.blocks.find((block) => block.kind === "text");
      if (text && text.kind === "text") return { id: message.id, text: text.text };
    }
    return null;
  }, [threadMessages]);

  useEffect(() => {
    setFollowThread(true);
    setQueued(null);
  }, [active?.id, activeGroup?.id]);

  useEffect(() => {
    if (!followThread) return;
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [followThread, threadMessages.length, working]);

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  useEffect(() => {
    if (!working && queued) {
      const text = queued;
      setQueued(null);
      setDraft(text);
      requestAnimationFrame(() => {
        void sendQueued(text);
      });
    }
  }, [working, queued]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      // ⌘K vale mesmo com o cursor no campo de escrever: é como se sai da conversa
      // para achar outra sem tirar a mão do teclado.
      if (opensPalette(event)) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        if (event.key !== "n" || !(event.metaKey || event.ctrlKey)) return;
      }
      const hit = shortcutFromKey(
        event,
        visibleShortcutTargets(bots, groups),
        active?.id ?? activeGroup?.id,
      );
      if (!hit) return;
      event.preventDefault();
      if (hit.action === "new-bot") {
        setPanel("create");
        return;
      }
      if (hit.target.kind === "group") navigate(`/app/g/${hit.target.id}`);
      else navigate(`/app/${hit.target.id}`);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bots, groups, active?.id, activeGroup?.id, navigate]);

  function runPaletteAction(item: PaletteItem) {
    const action = item.action;
    if (action.kind === "bot") {
      navigate(`/app/${action.id}`);
      return;
    }
    if (action.kind === "group") {
      navigate(`/app/g/${action.id}`);
      return;
    }
    if (action.kind === "route") {
      navigate(action.path);
      return;
    }
    // O computador tem porta própria: abrir só o painel deixaria a tela apagada
    // até alguém clicar de novo no botão do cabeçalho.
    if (action.panel === "computer") {
      void openComputer();
      return;
    }
    setPanel(action.panel);
  }

  return (
    <div
      className={`qb-dash relative flex h-full min-w-0 overflow-hidden text-[var(--qb-ink)]${
        panel ? " qb-dash--panel-open" : ""
      }${panel === "computer" ? " qb-dash--panel-wide" : ""}`}
    >
      <HostComputerPrompt />
      <aside
        className={`qb-dash__sidebar-wrap flex min-h-0 shrink-0 flex-col ${
          onInbox || !threadOpen ? "w-full md:w-[316px]" : "hidden w-[316px] md:flex"
        }`}
      >
        <Inbox
          bots={bots}
          groups={groups}
          query={query}
          selectedBotId={active?.id}
          selectedGroupId={activeGroup?.id}
          userName={userName}
          userImage={userImage}
          onQuery={setQuery}
          onAccount={() => setAccountOpen(true)}
          onPlugins={() => setPluginsOpen(true)}
          onCreateBot={() => setPanel("create")}
          onCreateGroup={() => {
            setQuery("");
            setPanel("create-group");
          }}
          onPin={(bot) => {
            void rpc.bots.update({ botId: bot.id, pinned: !bot.pinned }).then(() => refreshBots());
          }}
          onMarkUnread={(bot) => {
            void rpc.bots.update({ botId: bot.id, unread: true }).then(() => refreshBots());
          }}
          onEditBot={(bot) => {
            navigate(`/app/${bot.id}`);
            setPanel("settings");
          }}
          onDuplicate={(bot) => {
            void rpc.bots.duplicate({ botId: bot.id }).then(() => refreshBots());
          }}
          onHide={(bot) => {
            void rpc.bots.update({ botId: bot.id, hidden: !bot.hidden }).then(() => refreshBots());
          }}
          onClear={(bot) => {
            if (
              !window.confirm(
                `Limpar a conversa de ${bot.name}? Isso apaga as mensagens e para o trabalho atual. O bot, o computador, a memória e as rotinas ficam.`,
              )
            ) {
              return;
            }
            void rpc.threads.clear({ botId: bot.id }).then(() => {
              if (active?.id === bot.id) {
                setSnapshot((current) =>
                  current ? { ...current, messages: [], run: null } : current,
                );
              }
              return refreshBots();
            });
          }}
          onDeleteBot={(bot) => {
            if (!window.confirm(`Apagar ${bot.name}?`)) return;
            void rpc.bots.remove({ botId: bot.id }).then(() => refreshBots());
          }}
          onDeleteGroup={(group) => {
            if (!window.confirm(`Apagar ${group.name}?`)) return;
            void rpc.botGroups.remove({ groupId: group.id }).then(() => refreshGroups());
          }}
        />
      </aside>

      <main
        className={`qb-dash__main ${
          threadOpen
            ? onInbox
              ? "hidden md:flex md:flex-1"
              : "flex-1"
            : "hidden md:flex md:flex-1"
        }`}
      >
        <WorkerDownNotice alive={workerAlive} />
        <div className="qb-dash__topbar">
          <button
            type="button"
            aria-label="Voltar"
            onClick={() => navigate("/app")}
            className="flex h-8 shrink-0 items-center justify-start text-[28px] leading-none text-[var(--qb-ink)] md:hidden"
          >
            ‹
          </button>
          {activeGroup ? (
            <GlassSurface className="qb-dash__name-pill flex-1">
              <button
                type="button"
                aria-label="Ajustes do grupo"
                onClick={() => setPanel((p) => (p === "members" ? null : "members"))}
                className="qb-dash__name-btn w-full"
              >
                <GroupAvatar members={activeGroup.members} size={28} />
                <span className="qb-dash__active-name">{activeGroup.name}</span>
              </button>
            </GlassSurface>
          ) : (
            <GlassSurface className="qb-dash__name-pill flex-1">
              <button
                type="button"
                aria-label="Ajustes do bot"
                onClick={() => setPanel("settings")}
                className="qb-dash__name-btn w-full"
              >
                {active ? (
                  <span className="qb-dash__mascot" style={{ width: 26, height: 26 }}>
                    <BotAvatar
                      color={active.color}
                      shape={active.shape}
                      size={26}
                      state={working ? "working" : "idle"}
                    />
                  </span>
                ) : null}
                <span className="qb-dash__active-name">{active?.name ?? "Escolha um bot"}</span>
                {active?.chiefOfStaff ? (
                  <span className="hidden items-center gap-1 rounded-full bg-[rgba(10,132,255,.14)] px-2 py-0.5 text-[11px] font-medium text-[var(--qb-accent)] sm:flex">
                    <Icon name="crown" size={11} />
                    Chefe
                  </span>
                ) : null}
              </button>
            </GlassSurface>
          )}
          {activeGroup ? (
            <div className="relative">
              <button
                type="button"
                title="Computador"
                onClick={() => setGroupComputerMenu((open) => !open)}
                className="qb-dash__panel-toggle"
                aria-pressed={groupComputerMenu}
              >
                <Icon name="monitor" size={18} />
              </button>
              {groupComputerMenu ? (
                <div className="absolute top-9 right-0 z-40 min-w-[220px] rounded-[var(--qb-r-lg)] border border-[var(--qb-hairline)] bg-[var(--qb-canvas)] p-1.5 shadow-[0_18px_40px_rgba(0,0,0,.16)]">
                  {activeGroup.members.map((member) => (
                    <button
                      key={member.id}
                      type="button"
                      onClick={() => {
                        setGroupComputerMenu(false);
                        setPanel("computer");
                        navigate(`/app/${member.id}`);
                      }}
                      className="flex w-full items-center gap-2.5 rounded-[var(--qb-r-md)] px-3 py-2.5 text-left hover:bg-[var(--qb-surface-2)]"
                    >
                      <BotAvatar color={member.color} shape={member.shape} size={26} />
                      <span className="text-[17px] text-[var(--qb-ink)]">{member.name}</span>
                    </button>
                  ))}
                  {activeGroup.members.length === 0 ? (
                    <p className="px-2.5 py-2 text-[13.5px] text-[var(--qb-muted)]">
                      Nenhum bot neste grupo.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : active ? (
            <button
              type="button"
              className="qb-dash__panel-toggle"
              aria-pressed={panel === "computer"}
              aria-label="Abrir ou fechar o computador"
              title="Computador"
              onClick={() => setPanel((current) => (current === "computer" ? null : "computer"))}
            >
              <Icon name="monitor" size={18} />
            </button>
          ) : null}
        </div>
        {feedStatus === "reconnecting" || feedStatus === "offline" ? (
          <div className="qb-feed-notice" role="status">
            <span className="qb-feed-notice__dot" aria-hidden />
            {feedStatus === "offline"
              ? "Sem contato com o seu Quibt. Verifique se o computador que o roda está ligado."
              : "Reconectando à conversa…"}
          </div>
        ) : null}
        <div
          ref={threadRef}
          className="qb-dash__thread rk-scroll"
          onScroll={() => {
            const el = threadRef.current;
            if (!el) return;
            const previous = lastScrollTop.current;
            lastScrollTop.current = el.scrollTop;
            // Só volta a seguir o fim quando o fio está mesmo no fim. Enquanto bastava
            // estar perto (48px), subir um pouco religava o seguimento e o efeito puxava
            // a conversa de volta para baixo — a travadinha antes de "soltar".
            if (el.scrollHeight - el.scrollTop - el.clientHeight <= 4) {
              setFollowThread(true);
              return;
            }
            if (el.scrollTop < previous) setFollowThread(false);
          }}
        >
          {threadMessages.length === 0 ? (
            <div className="qb-dash__empty-thread">
              {active ? (
                <span className="qb-dash__mascot" style={{ width: 72, height: 72 }}>
                  <BotAvatar
                    color={active.color}
                    shape={active.shape}
                    size={72}
                    state={working ? "working" : "idle"}
                  />
                </span>
              ) : activeGroup ? (
                <GroupAvatar members={activeGroup.members} size={72} />
              ) : null}
              <div className="qb-dash__empty-title">
                {activeGroup?.name ?? active?.name ?? "Escolha um bot"}
              </div>
              <div>
                {activeGroup
                  ? `Manda uma mensagem para ${activeGroup.name} e dá o primeiro trabalho.`
                  : active
                    ? active.description ||
                      `Manda uma mensagem para ${active.name} e dá o primeiro trabalho.`
                    : "Escolha um bot na lista."}
              </div>
              {active || activeGroup ? (
                <div className="qb-dash__starters">
                  {starterPrompts(activeGroup?.name ?? active?.name ?? "aí").map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      className="qb-dash__starter"
                      onClick={() => {
                        setDraft(prompt);
                        setEditMessageId(null);
                        requestAnimationFrame(() => composerRef.current?.focus());
                      }}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {threadMessages.map((message) => {
            const burst = burstByLastId[message.id];
            const author = activeGroup
              ? groupAuthor(message, activeGroup.members)
              : peerAuthor(message, active?.id, bots);
            const computerHandoffActive = Boolean(
              !activeGroup &&
                snapshot?.run?.id === message.runId &&
                snapshot?.run?.status === "waiting_takeover",
            );
            return (
              <div key={message.id} data-run-id={message.runId ?? undefined}>
                {stamps[message.id] ? (
                  <div className="flex items-center justify-center py-1 text-[15px] text-[var(--qb-muted-2)]">
                    <span>{stamps[message.id]}</span>
                  </div>
                ) : null}
                <MessageView
                  message={message}
                  author={author}
                  authorNote={activeGroup ? undefined : author ? "teammate" : undefined}
                  groupLayout={Boolean(activeGroup)}
                  canEdit={Boolean(active && !working && message.role === "user")}
                  versionCount={active ? versionsOf(versionIndex, message).length : undefined}
                  versionIndex={
                    active
                      ? versionsOf(versionIndex, message).findIndex((row) => row.id === message.id)
                      : undefined
                  }
                  onEdit={(text) => {
                    setDraft(text);
                    setEditMessageId(message.id);
                  }}
                  onPrefill={(text) => {
                    setDraft(text);
                    setEditMessageId(null);
                    setMentionDismissed(false);
                    requestAnimationFrame(() => composerRef.current?.focus());
                  }}
                  onSwitchBranch={(direction) => {
                    if (!active) return;
                    const versions = versionsOf(versionIndex, message);
                    const index = versions.findIndex((row) => row.id === message.id);
                    const next = versions[index + direction];
                    if (!next) return;
                    void rpc.threads
                      .switchBranch({ botId: active.id, messageId: next.id })
                      .then(() => refreshThread(active.id));
                  }}
                  quoted={quotedTextFor(message.replyToId)}
                  askActive={
                    activeGroup
                      ? undefined
                      : Boolean(
                          snapshot?.run &&
                            snapshot.run.id === message.runId &&
                            snapshot.run.status === "waiting_input",
                        )
                  }
                  computerHandoffActive={computerHandoffActive}
                  computerPreview={computerHandoffActive ? previewShown?.image : null}
                  computerPreviewLabel={previewLabel}
                  computerBusy={booting}
                  onOpenComputer={!activeGroup && active ? () => void openComputer() : undefined}
                  onTakeOverComputer={
                    !activeGroup && active ? () => void takeOverComputer() : undefined
                  }
                  onReply={
                    active || activeGroup
                      ? () => {
                          setReplyTo(message);
                          requestAnimationFrame(() => composerRef.current?.focus());
                        }
                      : undefined
                  }
                  onReact={
                    active
                      ? (emoji) => {
                          setActionError(null);
                          void rpc.threads
                            .react({
                              botId: active.id,
                              messageId: message.id,
                              emoji,
                            })
                            .then(() => refreshThread(active.id))
                            .catch((err) => setActionFailure(err, "Não foi possível reagir"));
                        }
                      : undefined
                  }
                  onOpenBot={(id) => navigate(`/app/${id}`)}
                  onAnswer={(text) => {
                    const answerBotId = author?.id ?? active?.id;
                    if (!answerBotId || !message.runId) return;
                    setActionError(null);
                    void rpc.threads
                      .answer({
                        botId: answerBotId,
                        runId: message.runId,
                        answer: text,
                      })
                      .then(() => {
                        if (activeGroup) {
                          void refreshGroupThread(activeGroup.id).catch(() => undefined);
                        } else {
                          void refreshThread(answerBotId).catch(() => undefined);
                        }
                      })
                      .catch((err) => setActionFailure(err, "Não foi possível responder"));
                  }}
                />
                {burst ? (
                  <BurstSummary
                    messages={burst.messages}
                    authors={burst.authorIds.map(
                      (id) =>
                        authorLookup[id] ?? {
                          id,
                          name: "Agente",
                          color: "#3A3A40",
                        },
                    )}
                  />
                ) : null}
              </div>
            );
          })}
          {awaitingFirstWord ? (
            <div className="qb-msg-in flex justify-start">
              <div className="flex items-center gap-2.5 rounded-[var(--qb-r-lg)] bg-[var(--qb-surface)] px-4 py-[10px]">
                <span className="flex items-center gap-1.5">
                  <span className="size-1.5 animate-bounce rounded-full bg-[var(--qb-muted)] [animation-delay:0ms]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-[var(--qb-muted)] [animation-delay:150ms]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-[var(--qb-muted)] [animation-delay:300ms]" />
                </span>
                <span className="qb-thinking text-[14px]">trabalhando…</span>
              </div>
            </div>
          ) : null}
        </div>
        {!followThread ? (
          <button
            type="button"
            className="qb-pop-in absolute bottom-24 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--qb-hairline)] bg-[var(--qb-canvas)] px-3 py-1.5 text-[12.5px] text-[var(--qb-ink)] shadow-[0_10px_24px_rgba(20,20,24,.12)]"
            onClick={() => {
              setFollowThread(true);
              threadRef.current?.scrollTo({
                top: threadRef.current.scrollHeight,
                behavior: "smooth",
              });
            }}
          >
            <Icon name="arrowDown" size={13} />
            Ir ao mais recente
          </button>
        ) : null}
        <div className="qb-dash__composer relative">
          {replyTo ? (
            <div className="qb-composer-reply">
              <Icon name="reply" size={13} />
              <span className="min-w-0 flex-1 truncate">
                {quotedTextFor(replyTo.id) ?? "Recado citado"}
              </span>
              <button
                type="button"
                aria-label="Cancelar resposta"
                onClick={() => setReplyTo(null)}
                className="shrink-0 rounded-md p-1 hover:bg-[var(--qb-surface)]"
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          ) : null}
          {mentionMatches.length ? (
            <div className="absolute right-2 bottom-full left-2 mb-2 rounded-xl border border-[var(--qb-hairline)] bg-[var(--qb-canvas)] p-1.5 shadow-[0_18px_46px_rgba(20,20,24,.14)]">
              {mentionMatches.map((candidate, i) => (
                <button
                  key={candidate.id}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    acceptMention(candidate);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-[var(--qb-r-md)] px-2.5 py-2 text-left"
                  style={{
                    background: i === mentionIndex ? "var(--qb-surface-2)" : "transparent",
                  }}
                >
                  {candidate.color ? (
                    <BotAvatar color={candidate.color} shape={candidate.shape} size={22} />
                  ) : (
                    <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-[var(--qb-hairline)] text-[12px] text-[var(--qb-muted)]">
                      {candidate.kind === "skill" ? "/" : "@"}
                    </span>
                  )}
                  <span className="text-[15px] text-[var(--qb-ink)]">{candidate.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[15px] text-[var(--qb-muted)]">
                    {candidate.title}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          {queued ? (
            <div className="qb-dash__queue">
              <Icon name="clock" size={13} />
              <span className="min-w-0 flex-1 truncate">
                Na fila — envia quando {activeGroup?.name ?? active?.name ?? "o bot"} terminar: “
                {queued}”
              </span>
              <button
                type="button"
                aria-label="Descartar fila"
                onClick={() => setQueued(null)}
                className="text-[var(--qb-muted)] hover:text-[var(--qb-ink)]"
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          ) : null}
          {actionError ? (
            <div className="mb-2 rounded-[var(--qb-r-md)] bg-[#FFF0EF] px-3 py-2 text-[13px] text-[var(--qb-danger)]">
              {actionError.message}{" "}
              {isPlanLimitError(actionError.cause) && billing?.enabled ? (
                <button
                  type="button"
                  onClick={() => navigate("/billing")}
                  className="font-semibold text-[#8F1712]"
                >
                  Ver planos
                </button>
              ) : null}
              {/* Modelo ausente, chave recusada ou sem crédito: o conserto é um só lugar,
                  Conta → Modelo. Sem o botão a pessoa lia "401" e ficava parada. */}
              {needsModelConnection(actionError.message) ? (
                <button
                  type="button"
                  onClick={() => {
                    setActionError(null);
                    setSettingsModal("models");
                  }}
                  className="font-semibold text-[#8F1712]"
                >
                  Conectar modelo
                </button>
              ) : null}
            </div>
          ) : null}
          {attachments.length || attaching || transcribing.state !== "idle" ? (
            <div className="qb-composer-files">
              {attachments.map((file) => (
                <span key={file.id} className="qb-composer-file">
                  <Icon name="paperclip" size={13} />
                  <span className="truncate">{file.name}</span>
                  <button
                    type="button"
                    aria-label={`Tirar ${file.name}`}
                    onClick={() =>
                      setAttachments((current) => current.filter((row) => row.id !== file.id))
                    }
                  >
                    <Icon name="close" size={12} />
                  </button>
                </span>
              ))}
              {attaching ? <span className="qb-composer-file is-loading">enviando…</span> : null}
              {transcribing.state !== "idle" ? (
                <span className="qb-composer-file is-loading" aria-live="polite">
                  {transcribing.state === "loading"
                    ? `baixando o modelo de voz${
                        transcribing.percent ? ` ${transcribing.percent}%` : "…"
                      }`
                    : "transcrevendo…"}
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="qb-dash__input-shell">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) void attachFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <div className="relative self-center">
              <button
                type="button"
                className="qb-dash__composer-plus"
                aria-label="Mais"
                title="Mais"
                disabled={attaching}
                onClick={() => setComposerMenu((open) => !open)}
              >
                <Icon name="plus" size={18} />
              </button>
              {composerMenu ? (
                <>
                  <button
                    type="button"
                    aria-label="Fechar menu"
                    className="fixed inset-0 z-10 cursor-default bg-transparent"
                    onClick={() => setComposerMenu(false)}
                  />
                  <div className="qb-menu qb-composer-menu qb-pop-in" role="menu">
                    <MenuItem
                      icon="paperclip"
                      label="Anexar arquivos"
                      onClick={() => {
                        setComposerMenu(false);
                        fileInputRef.current?.click();
                      }}
                    />
                    {active ? (
                      <MenuItem
                        icon="machine"
                        label="Ensinar uma tarefa"
                        onClick={() => {
                          setComposerMenu(false);
                          void startTeaching();
                        }}
                      />
                    ) : null}
                  </div>
                </>
              ) : null}
            </div>
            <textarea
              ref={composerRef}
              rows={1}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setCaret(e.target.selectionStart ?? e.target.value.length);
                setMentionDismissed(false);
              }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              onKeyDown={onComposerKeyDown}
              placeholder={
                editMessageId
                  ? "Editar e ramificar"
                  : working
                    ? `${activeGroup?.name ?? active?.name ?? "O bot"} está trabalhando — Enter coloca na fila`
                    : activeGroup
                      ? `Mensagem para ${activeGroup.name}`
                      : active
                        ? `Mensagem para ${active.name}`
                        : "Mensagem"
              }
              aria-label={
                activeGroup
                  ? `Mensagem para ${activeGroup.name}`
                  : active
                    ? `Mensagem para ${active.name}`
                    : "Mensagem"
              }
            />
            {working && (active || activeGroup) ? (
              <button
                type="button"
                onClick={() => void stopWorkingRuns()}
                disabled={stopping}
                aria-busy={stopping}
                className="qb-dash__send self-center"
                aria-label={stopping ? "Parando agente" : "Parar agente"}
              >
                <Icon name="stop" size={12} />
              </button>
            ) : dictating ? (
              <>
                <span className="qb-recording self-center" aria-live="polite">
                  <span className="qb-recording__dot" />
                  <span className="rk-mono">{formatDuration(recordSeconds)}</span>
                </span>
                <button
                  type="button"
                  aria-label="Descartar gravação"
                  title="Descartar"
                  onClick={cancelRecording}
                  className="grid h-8 w-8 place-items-center self-center text-[var(--qb-muted)]"
                >
                  <Icon name="close" size={16} />
                </button>
                <button
                  type="button"
                  aria-label="Encerrar gravação"
                  title="Encerrar e anexar"
                  onClick={() => void finishRecording()}
                  className="qb-dash__send self-center"
                >
                  <Icon name="check" size={16} />
                </button>
              </>
            ) : (
              <>
                {canRecord && !draft.trim() ? (
                  <button
                    type="button"
                    aria-label="Gravar recado de voz"
                    title="Gravar recado de voz"
                    onClick={() => void startRecording()}
                    className="grid h-8 w-8 place-items-center self-center text-[var(--qb-muted)]"
                  >
                    <Icon name="mic" size={16} />
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void send()}
                  className={`qb-dash__send self-center${working ? " is-queue" : ""}`}
                  aria-label={working ? "Colocar na fila" : "Enviar"}
                >
                  {working ? <Icon name="clock" size={15} /> : <Icon name="send" size={16} />}
                </button>
              </>
            )}
          </div>
        </div>
      </main>

      {panel ? (
        <div className="qb-dash__panel absolute inset-0 z-20 md:relative md:inset-auto md:z-auto md:w-[320px] md:grow-0 md:shrink-0">
          <div className="mx-auto min-h-full w-full max-w-[430px] md:max-w-none">
            {panel === "create-group" ? (
              <NewGroupForm
                bots={bots}
                error={actionError?.message ?? null}
                onPlans={
                  isPlanLimitError(actionError?.cause) && billing?.enabled
                    ? () => navigate("/billing")
                    : undefined
                }
                onCancel={() => setPanel(activeGroup ? "members" : null)}
                onCreate={(input) => void createGroup(input)}
              />
            ) : null}
            {panel === "members" && activeGroup ? (
              <GroupMembersPane
                key={activeGroup.id}
                group={activeGroup}
                bots={bots}
                routines={groupRoutines}
                onClose={() => setPanel(null)}
                onRename={async (name) => {
                  await rpc.botGroups.update({ groupId: activeGroup.id, name });
                  await refreshGroups();
                }}
                onSaveInstructions={async (instructions) => {
                  await rpc.botGroups.update({
                    groupId: activeGroup.id,
                    instructions,
                  });
                  await refreshGroups();
                }}
                onAddRoutine={() => {
                  setRoutineDraft(emptyRoutineDraft());
                  setPanel("routine");
                }}
                onToggleRoutine={async (routine, nextActive) => {
                  await rpc.routines.update({
                    routineId: routine.id,
                    active: nextActive,
                  });
                  await refreshGroupRoutines(activeGroup.id);
                }}
                onRemoveRoutine={async (routine) => {
                  await rpc.routines.remove({ routineId: routine.id });
                  await refreshGroupRoutines(activeGroup.id);
                }}
                onAddMember={async (memberId) => {
                  await rpc.botGroups.addMember({
                    groupId: activeGroup.id,
                    botId: memberId,
                  });
                  await refreshGroups();
                }}
                onRemoveMember={async (memberId) => {
                  await rpc.botGroups.removeMember({
                    groupId: activeGroup.id,
                    botId: memberId,
                  });
                  await refreshGroups();
                }}
                onDelete={async () => {
                  await rpc.botGroups.remove({ groupId: activeGroup.id });
                  await refreshGroups();
                  setPanel(null);
                  navigate("/app", { replace: true });
                }}
              />
            ) : null}
            {active && panel === "computer" ? (
              <div className="qb-dash__panel-head">
                <span>computador de {active.name}</span>
                <div className="qb-dash__panel-actions">
                  <button
                    type="button"
                    aria-label="Abrir ajustes"
                    onClick={() => setPanel("settings")}
                  >
                    <Icon name="settings" size={17} />
                  </button>
                  <button type="button" aria-label="Fechar painel" onClick={() => setPanel(null)}>
                    <Icon name="chevronRight" size={18} />
                  </button>
                </div>
              </div>
            ) : null}
            {active && panel === "computer" ? (
              <div>
                {actionError ? (
                  <div className="mb-3 rounded-[var(--qb-r-md)] bg-[#FFF0EF] px-3 py-2 text-[13px] text-[var(--qb-danger)]">
                    {actionError.message}{" "}
                    {isPlanLimitError(actionError.cause) && billing?.enabled ? (
                      <button
                        type="button"
                        onClick={() => navigate("/billing")}
                        className="font-semibold text-[#8F1712]"
                      >
                        Ver planos
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <button
                  type="button"
                  className="qb-dash__screen"
                  aria-label={holdsControl ? "Abrir computador" : "Assumir controle do computador"}
                  onClick={() => void openComputer()}
                >
                  {computerOpen ? (
                    <ComputerPreview bare host="desktop" title="Aberto em tela cheia" />
                  ) : computer?.state === "running" && pinnedScreenUrl ? (
                    <ComputerPreview bare host="desktop" title={`tela de ${active.name}`}>
                      <iframe
                        ref={attachScreenFrame}
                        title="Prévia da tela do bot"
                        src={pinnedScreenUrl}
                        sandbox={screenIframeSandbox(pinnedScreenUrl)}
                        className="h-full min-h-[120px] w-full border-0 bg-[var(--qb-rail)]"
                        allow="clipboard-read; clipboard-write"
                        style={{ pointerEvents: "none" }}
                      />
                    </ComputerPreview>
                  ) : computer?.state === "running" && previewShown && !screenLost ? (
                    // Sem o controle: o retrato mais recente, com a idade em cima, para
                    // ninguém tomar uma tela velha por atual. Uma falha de poll não o
                    // apaga: o sub-rótulo avisa que está tentando de novo.
                    <ComputerPreview bare host="desktop" title={`tela de ${active.name}`}>
                      <img
                        className="qb-dash__window-image"
                        src={previewShown.image}
                        alt={`Tela do computador de ${active.name}`}
                      />
                      <span className="qb-live-badge" aria-live="off">
                        <span className="qb-live-badge__dot" aria-hidden="true" />
                        {previewLabel}
                      </span>
                      {previewFailed ? (
                        <span className="qb-live-badge is-muted qb-live-badge--sub">
                          sem prévia · tentando de novo
                        </span>
                      ) : null}
                    </ComputerPreview>
                  ) : computer?.state === "running" && !screenLost ? (
                    // Ainda sem retrato (ou a prévia falhou): a ilustração de mesa, com o
                    // selo dizendo por quê — sem ele parecia a tela de verdade, travada.
                    <ComputerPreview bare host="desktop" title={`tela de ${active.name}`}>
                      <img
                        className="qb-dash__window-image"
                        src={computerDesktopImage}
                        alt={`Tela do computador de ${active.name}`}
                      />
                      <span className="qb-live-badge is-muted">
                        {othersControl
                          ? "Outra pessoa está no controle"
                          : previewFailed
                            ? "sem prévia · tentando de novo"
                            : "buscando a tela…"}
                      </span>
                    </ComputerPreview>
                  ) : (
                    <ComputerPreview
                      bare
                      host="desktop"
                      title={
                        screenLost
                          ? "A tela caiu e não voltou"
                          : computer?.state === "booting" || booting
                            ? `Abrindo a tela de ${active.name}…`
                            : computer?.state === "suspended"
                              ? "Computador dormindo"
                              : computer?.state === "error"
                                ? "Não conseguiu ligar"
                                : "Computador parado"
                      }
                      lines={
                        screenLost
                          ? ["Toque pra abrir de novo."]
                          : computer?.state === "suspended"
                            ? ["Assuma o controle pra acordar."]
                            : []
                      }
                    />
                  )}
                  <span className="qb-dash__screen-open">
                    <Icon name="expand" size={14} />
                    Abrir
                  </span>
                </button>
                <div className="qb-dash__screen-meta">
                  <span>
                    {holdsControl
                      ? `Você tem o controle ${controlUntilLabel(computer?.controlLeaseExpiresAt) ?? ""}`.trim()
                      : othersControl
                        ? "Outra pessoa está no controle"
                        : computer?.state === "suspended"
                          ? "Dormindo"
                          : `tela de ${active.name}`}
                  </span>
                  {/* Um botão de contorno vazio pesava mais que a própria prévia. */}
                  <button
                    type="button"
                    className="qb-dash__screen-action"
                    onClick={() =>
                      holdsControl ? void releaseComputer() : void takeOverComputer()
                    }
                  >
                    {holdsControl ? "Liberar" : "Assumir controle"}
                  </button>
                </div>
                {routines.length === 0 ? (
                  <div className="qb-dash__empty-routines">
                    <p>Rotinas são tarefas recorrentes que este bot roda no horário.</p>
                    <button
                      type="button"
                      className="qb-dash__ghost-btn"
                      onClick={() => {
                        setRoutineDraft(emptyRoutineDraft());
                        setPanel("routine");
                      }}
                    >
                      Criar rotina
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="qb-dash__panel-label">Rotinas</div>
                    {routines.map((routine) => (
                      <button
                        key={routine.id}
                        type="button"
                        onClick={() => {
                          setRoutineDraft({
                            id: routine.id,
                            name: routine.name,
                            prompt: routine.prompt,
                            schedule: presetFromCron(routine.cron),
                            active: routine.active,
                          });
                          setPanel("routine");
                        }}
                        className="qb-dash__routine"
                      >
                        <span className="qb-dash__routine-icon">◷</span>
                        <span className="qb-dash__routine-name">{routine.name}</span>
                        <span className="qb-dash__routine-when">
                          {routine.active ? formatCron(routine.cron) : "Pausada"}
                        </span>
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        setRoutineDraft(emptyRoutineDraft());
                        setPanel("routine");
                      }}
                      className="qb-dash__quiet"
                    >
                      + Nova rotina
                    </button>
                  </>
                )}
              </div>
            ) : null}
            {panel === "create" ? (
              <CreateBotForm
                error={actionError?.message ?? null}
                onPlans={
                  isPlanLimitError(actionError?.cause) && billing?.enabled
                    ? () => navigate("/billing")
                    : undefined
                }
                onCancel={() => setPanel(null)}
                onCreate={(input) => void createBot(input)}
              />
            ) : null}
            {active && panel === "settings" ? (
              <AgentSettings
                key={active.id}
                bot={active}
                routines={routines}
                onOpenInstructions={() => setPanel("instructions")}
                onOpenMemory={() => setPanel("memory")}
                onOpenWebhooks={() => setPanel("webhooks")}
                onOpenRoutine={(routine) => {
                  setRoutineDraft({
                    id: routine.id,
                    name: routine.name,
                    prompt: routine.prompt,
                    schedule: presetFromCron(routine.cron),
                    active: routine.active,
                  });
                  setPanel("routine");
                }}
                onAddRoutine={() => {
                  setRoutineDraft(emptyRoutineDraft());
                  setPanel("routine");
                }}
                onBack={() => setPanel("computer")}
                onClose={() => setPanel(null)}
                onSave={async (patch) => {
                  await rpc.bots.update({ botId: active.id, ...patch });
                  await refreshBots();
                }}
                onExport={async () => {
                  const manifest = await rpc.export.bot({ botId: active.id });
                  const blob = new Blob([JSON.stringify(manifest, null, 2)], {
                    type: "application/json",
                  });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `${active.name.toLowerCase().replace(/\s+/g, "-")}-export.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                onClear={async () => {
                  await rpc.threads.clear({ botId: active.id });
                  setSnapshot((current) =>
                    current ? { ...current, messages: [], run: null } : current,
                  );
                  await refreshBots();
                }}
                onDelete={async () => {
                  await rpc.bots.remove({ botId: active.id });
                  setPanel(null);
                  await refreshBots();
                }}
              />
            ) : null}
            {active && panel === "instructions" ? (
              <InstructionsPanel
                key={active.id}
                bot={active}
                onBack={() => setPanel("settings")}
                onSave={async (instructions) => {
                  await rpc.bots.update({ botId: active.id, instructions });
                  await refreshBots();
                  setPanel("settings");
                }}
              />
            ) : null}
            {active && panel === "memory" ? (
              <MemoryPanel key={active.id} bot={active} onBack={() => setPanel("settings")} />
            ) : null}
            {active && panel === "webhooks" ? (
              <WebhooksPanel
                key={active.id}
                bot={active}
                onOpenRun={(runId) => void openWebhookRun(runId)}
                onBack={() => setPanel("settings")}
                onClose={() => setPanel(null)}
              />
            ) : null}
            {(active || activeGroup) && panel === "routine" ? (
              <div>
                <div className="qb-dash__subhead">
                  <button
                    type="button"
                    onClick={() => setPanel(activeGroup ? "members" : "computer")}
                    aria-label="Voltar às rotinas"
                  >
                    <Icon name="chevronLeft" size={17} />
                  </button>
                  <span>Rotina</span>
                  <button type="button" onClick={() => setPanel(null)} aria-label="Fechar rotina">
                    <Icon name="chevronRight" size={18} />
                  </button>
                </div>
                <div className="qb-routine__toolbar">
                  <Switch
                    className="qb-grok-switch"
                    checked={routineDraft.active}
                    onCheckedChange={(active) =>
                      setRoutineDraft((current) => ({ ...current, active }))
                    }
                  />
                  <span>{routineDraft.active ? "Ativa" : "Pausada"}</span>
                  <button
                    type="button"
                    className="qb-routine__action"
                    disabled={!routineDraft.id}
                    onClick={async () => {
                      if (!routineDraft.id || !window.confirm("Apagar esta rotina?")) return;
                      await rpc.routines.remove({ routineId: routineDraft.id });
                      if (activeGroup) await refreshGroupRoutines(activeGroup.id);
                      if (active) await refreshThread(active.id).catch(() => undefined);
                      setPanel(activeGroup ? "members" : "computer");
                    }}
                  >
                    Apagar
                  </button>
                  <button
                    type="button"
                    className="qb-routine__action"
                    disabled={!routineDraft.id}
                    onClick={async () => {
                      if (!routineDraft.id) return;
                      setActionError(null);
                      try {
                        await rpc.routines.testRun({
                          routineId: routineDraft.id,
                        });
                        if (active) await refreshThread(active.id).catch(() => undefined);
                      } catch (err) {
                        setActionFailure(err, "Não foi possível testar a rotina");
                      }
                    }}
                  >
                    Testar
                  </button>
                </div>
                <label className="qb-dash__field">
                  Nome
                  <input
                    value={routineDraft.name}
                    placeholder="Dê um nome a esta rotina"
                    onChange={(e) => setRoutineDraft((s) => ({ ...s, name: e.target.value }))}
                  />
                </label>
                <label className="qb-dash__field">
                  Instrução
                  <textarea
                    value={routineDraft.prompt}
                    placeholder="O que este bot deve fazer toda vez que rodar?"
                    onChange={(e) => setRoutineDraft((s) => ({ ...s, prompt: e.target.value }))}
                    rows={4}
                  />
                </label>
                <div className="mt-5 text-[14px] text-[var(--qb-muted)]">Quando rodar</div>
                <details className="qb-routine__schedule">
                  <summary>
                    <Icon name="plus" size={15} />
                    {routineDraft.id
                      ? formatCron(cronFromPreset(routineDraft.schedule))
                      : "Adicionar horário"}
                  </summary>
                  <RoutineSchedule
                    value={routineDraft.schedule}
                    onChange={(schedule) => setRoutineDraft((s) => ({ ...s, schedule }))}
                  />
                </details>
                <div className="qb-routine__history">
                  <span>Histórico de execuções</span>
                  <p>
                    {routineDraft.id ? "As execuções aparecem aqui." : "Nenhuma execução ainda."}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={routineSaving}
                  onClick={async () => {
                    if (routineSaving) return;
                    const base = {
                      name: routineDraft.name || "Rotina",
                      prompt: routineDraft.prompt || "Dá uma olhada.",
                      cron: cronFromPreset(routineDraft.schedule),
                      timezone: deviceTimezone(),
                      active: routineDraft.active,
                      notify: true,
                    };
                    setActionError(null);
                    setRoutineSaving(true);
                    try {
                      if (routineDraft.id) {
                        await rpc.routines.update({
                          routineId: routineDraft.id,
                          ...base,
                        });
                      } else if (activeGroup) {
                        await rpc.routines.create({
                          groupId: activeGroup.id,
                          ...base,
                        });
                      } else if (active) {
                        await rpc.routines.create({
                          botId: active.id,
                          ...base,
                        });
                      } else {
                        return;
                      }
                      if (activeGroup) {
                        await refreshGroupRoutines(activeGroup.id);
                        setPanel("members");
                        return;
                      }
                      if (active) await refreshThread(active.id).catch(() => undefined);
                      setPanel("computer");
                    } catch (err) {
                      setActionFailure(err, "Não foi possível salvar a rotina");
                    } finally {
                      setRoutineSaving(false);
                    }
                  }}
                  className="qb-routine__save"
                >
                  {routineSaving ? "Salvando…" : "Salvar"}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {accountOpen ? (
        <AccountSheet
          name={userName}
          email={userEmail}
          image={userImage}
          billing={billing}
          billingBusy={billingBusy}
          billingError={billingError}
          usage={usage}
          onLoadUsage={() => {
            void rpc.usage.summary().then(setUsage);
          }}
          onPlugins={() => {
            setAccountOpen(false);
            setPluginsOpen(true);
          }}
          onCheckout={(planId) => void openBillingUrl(() => rpc.billing.checkout({ planId }))}
          onPortal={() => void openBillingUrl(() => rpc.billing.portal())}
          onPlans={() => {
            setAccountOpen(false);
            if (billing?.enabled) navigate("/billing");
            else navigate("/settings/machine");
          }}
          onModel={() => {
            setAccountOpen(false);
            setSettingsModal("models");
          }}
          onMachine={() => {
            setAccountOpen(false);
            setSettingsModal("machine");
          }}
          onPhone={() => {
            setAccountOpen(false);
            setSettingsModal("phone");
          }}
          onProfile={() => {
            setAccountOpen(false);
            setSettingsModal("account");
          }}
          onSignOut={() => void authClient.signOut().then(() => navigate("/"))}
          onUninstall={
            desktopBridge()?.uninstall
              ? () => {
                  setAccountOpen(false);
                  void desktopBridge()?.uninstall?.();
                }
              : undefined
          }
          onClose={() => setAccountOpen(false)}
        />
      ) : null}

      {settingsModal ? (
        <SettingsPanel
          initial={settingsModal}
          onClose={() => setSettingsModal(null)}
          onSignedOut={() => setSettingsModal(null)}
        />
      ) : null}

      {pluginsOpen ? (
        <PluginsOverlay
          onClose={() => {
            setPluginsOpen(false);
            void refreshComposerRefs();
          }}
        />
      ) : null}

      {booting ? (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-[22px] bg-[rgba(4,4,5,.96)]">
          <div className="text-[19px] font-medium text-[var(--qb-surface-2)]">
            Abrindo a tela de {active?.name} no seu computador
          </div>
          <div className="max-w-[420px] text-center text-[14px] leading-[1.5] text-[var(--qb-muted)]">
            Uma máquina compartilhada por você e pelos bots — cada um tem a tela dele nela.
          </div>
          <div className="h-[5px] w-[min(420px,70%)] overflow-hidden rounded-full bg-[var(--qb-ink-strong)]">
            <div className="h-full w-2/3 rounded-full bg-[var(--qb-surface-2)]" />
          </div>
        </div>
      ) : computerOpen && active ? (
        <div className="absolute inset-0 z-30 flex flex-col bg-[var(--qb-rail)]">
          <div
            className="app-drag flex items-center justify-between gap-4 border-b border-[var(--qb-hairline)] bg-[var(--qb-canvas)] px-[18px] py-3"
            // No app do Mac os botões da janela flutuam sobre o conteúdo: sem esta
            // faixa livre, o nome do bot nascia embaixo de fechar/minimizar.
            style={{ paddingLeft: trafficLightInset() || undefined }}
          >
            <div className="flex min-w-0 items-center gap-3">
              <BotAvatar
                color={active.color}
                shape={active.shape}
                size={28}
                state={working ? "working" : "idle"}
              />
              <span className="truncate text-[15.5px] font-medium text-[var(--qb-ink)]">
                {active.name} — tela
              </span>
              <span className="shrink-0 text-[13px] text-[var(--qb-muted)]">
                no computador compartilhado
              </span>
              {computer?.controlHolder === "user" ? (
                <span className="rounded-full bg-[rgba(44,138,75,.12)] px-[11px] py-1 text-[13px] font-medium text-[#2C8A4B]">
                  Você tem o controle
                </span>
              ) : null}
            </div>
            <div className="app-no-drag relative flex items-center gap-3">
              {computer?.controlHolder === "user" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void releaseComputer()}
                >
                  Liberar
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void takeOverComputer()}
                >
                  Assumir controle
                </Button>
              )}
              <button
                type="button"
                aria-label="Menu do computador"
                className="grid h-8 w-8 place-items-center rounded-full text-[var(--qb-muted)] hover:bg-[var(--qb-surface-2)] hover:text-[var(--qb-ink)]"
                onClick={() => setComputerMenu((v) => !v)}
              >
                ···
              </button>
              {computerMenu ? (
                <div className="qb-menu absolute top-11 right-10 z-40 min-w-[200px] p-1.5">
                  <button
                    type="button"
                    className="qb-menu__item"
                    onClick={() => {
                      setComputerMenu(false);
                      void toggleTrackpadMode();
                    }}
                  >
                    <span>🖱️</span> {trackpadMode ? "Sair do modo trackpad" : "Modo trackpad"}
                  </button>
                  <button
                    type="button"
                    className="qb-menu__item"
                    onClick={() => {
                      void pasteToComputer();
                      setComputerMenu(false);
                    }}
                  >
                    <span>📋</span> Colar
                  </button>
                </div>
              ) : null}
              <button
                type="button"
                className="grid h-8 w-8 place-items-center rounded-full text-[16px] text-[var(--qb-muted)] hover:bg-[var(--qb-surface-2)] hover:text-[var(--qb-ink)]"
                aria-label="Fechar computador"
                onClick={() => closeComputerOverlay()}
              >
                ✕
              </button>
            </div>
          </div>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: no modo trackpad esta área É o trackpad; fora dele os handlers não fazem nada. */}
          <div
            ref={trackpadSurface}
            tabIndex={trackpadMode ? 0 : -1}
            className={`min-h-0 flex-1 bg-[var(--qb-rail)] outline-none ${trackpadMode ? "cursor-none" : ""}`}
            onPointerDown={onTrackpadPointerDown}
            onPointerMove={onTrackpadMove}
            onPointerUp={onTrackpadPointerUp}
            onContextMenu={(event) => {
              if (trackpadMode) event.preventDefault();
            }}
            onKeyDown={onTrackpadKeyDown}
          >
            {computer?.state === "running" && pinnedScreenUrl ? (
              <div className="relative h-full w-full">
                {trackpadMode ? (
                  <div className="pointer-events-none absolute top-3 left-1/2 z-20 -translate-x-1/2 rounded-full bg-[var(--qb-ink-strong)] px-4 py-1.5 text-[13px] text-[var(--qb-canvas)]">
                    {trackpadLive
                      ? "Modo trackpad: mova o mouse, clique para clicar, digite para escrever · Esc sai"
                      : "Assumindo o controle do computador…"}
                  </div>
                ) : null}
                <iframe
                  ref={attachScreenFrame}
                  title="Tela do bot"
                  src={pinnedScreenUrl}
                  sandbox={screenIframeSandbox(pinnedScreenUrl)}
                  className="h-full w-full border-0 bg-[var(--qb-rail)]"
                  allow="clipboard-read; clipboard-write; fullscreen"
                  style={{
                    pointerEvents: trackpadMode
                      ? "none"
                      : computer?.controlHolder === "user"
                        ? "auto"
                        : "none",
                  }}
                />
                {/* Sem o controle, a tela é só de olhar — mas um clique engolido em silêncio
                    parecia travamento. O clique agora oferece assumir, ali mesmo. */}
                {teaching ? (
                  <div className="qb-teach-bar">
                    <span className="qb-teach-bar__dot" aria-hidden="true" />
                    <span className="qb-teach-bar__label">Ensinando</span>
                    <input
                      className="qb-teach-bar__notes"
                      value={teachNotes}
                      onChange={(event) => setTeachNotes(event.target.value)}
                      placeholder="Diga o que está fazendo (opcional)"
                      aria-label="O que você está ensinando"
                    />
                    <button
                      type="button"
                      className="qb-primary-button"
                      disabled={teachBusy}
                      onClick={() => void finishTeaching()}
                    >
                      {teachBusy ? "Fechando…" : "Salvar tarefa"}
                    </button>
                    <button
                      type="button"
                      className="qb-secondary-button"
                      disabled={teachBusy}
                      onClick={() => {
                        setTeaching(false);
                        setComputerOpen(false);
                      }}
                    >
                      Cancelar
                    </button>
                  </div>
                ) : null}
                {computer?.controlHolder !== "user" && !trackpadMode ? (
                  <button
                    type="button"
                    className="qb-screen-claim"
                    aria-label="Assumir controle do computador"
                    onClick={() => void takeOverComputer()}
                  >
                    <span className="qb-screen-claim__pill">
                      {active.name} está com o mouse · Assumir controle
                    </span>
                  </button>
                ) : null}
              </div>
            ) : computer?.state === "running" && previewShown && !screenLost ? (
              // Sem o controle: o retrato mais recente ocupa a tela, com a idade no canto e
              // a pílula de assumir — o clique continua oferecendo entrar, como no stream.
              // Com outra pessoa no controle a pílula só avisa: a API negaria o assumir.
              <div className="relative h-full w-full">
                <img
                  className="qb-screen-still"
                  src={previewShown.image}
                  alt={`Tela do computador de ${active.name}`}
                />
                <span className="qb-live-badge qb-live-badge--overlay">
                  <span className="qb-live-badge__dot" aria-hidden="true" />
                  {previewLabel}
                </span>
                {previewFailed ? (
                  <span className="qb-live-badge is-muted qb-live-badge--overlay qb-live-badge--sub">
                    sem prévia · tentando de novo
                  </span>
                ) : null}
                {othersControl ? (
                  <span className="qb-screen-claim is-static">
                    <span className="qb-screen-claim__pill">Outra pessoa está no controle</span>
                  </span>
                ) : !trackpadMode ? (
                  <button
                    type="button"
                    className="qb-screen-claim"
                    aria-label="Assumir controle do computador"
                    onClick={() => void takeOverComputer()}
                  >
                    <span className="qb-screen-claim__pill">
                      {active.name} está com o mouse · Assumir controle
                    </span>
                  </button>
                ) : null}
              </div>
            ) : (
              // Nunca a ilustração de mesa aqui: em tela cheia ela passava por tela de verdade,
              // e quem clicava nela achava que o controle tinha quebrado.
              <div className="grid h-full place-items-center px-6 text-center">
                <div className="flex max-w-[340px] flex-col items-center gap-3">
                  <p className="text-sm leading-[1.5] text-[var(--qb-muted)]">
                    {screenLost
                      ? "A tela caiu e não voltou."
                      : computer?.state === "suspended"
                        ? "Este computador está dormindo."
                        : computer?.state === "running" && holdsControl
                          ? `Procurando a tela de ${active.name}…`
                          : computer?.state === "running" && othersControl
                            ? `Outra pessoa está no controle do computador de ${active.name}.`
                            : computer?.state === "running" && previewFailed
                              ? `Sem prévia da tela de ${active.name} por enquanto. Tentando de novo…`
                              : computer?.state === "running"
                                ? `Buscando a tela de ${active.name}…`
                                : booting || computer?.state === "booting"
                                  ? "Ligando o computador…"
                                  : "O computador está parado."}
                  </p>
                  {screenLost ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void bootComputer({
                          takeControl: false,
                          overlay: true,
                          force: true,
                        })
                      }
                    >
                      Tentar de novo
                    </Button>
                  ) : computer?.controlHolder === "user" ? null : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void takeOverComputer()}
                    >
                      Assumir controle
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
      {paletteOpen ? (
        <CommandPalette
          items={buildPaletteItems(bots, groups, { hasActiveBot: Boolean(active) })}
          onClose={() => setPaletteOpen(false)}
          onPick={(item) => {
            setPaletteOpen(false);
            runPaletteAction(item);
          }}
        />
      ) : null}
    </div>
  );
}
