import {
  AgentMark,
  Button,
  CharacterPicker,
  MARK_STYLE_COLORS,
  PICKER_SHAPES,
  type MarkShape,
} from "@quibt/ui-web";
import { useEffect, useMemo, useRef, useState } from "react";
import { DEMO_BOTS_EN } from "../demo.en";
import {
  DEMO_BOTS,
  type DemoBot,
  type DemoMessage,
  type DemoRoutine,
} from "../demo";
import type { Locale } from "../i18n";

const NUMBERS = [1, 2, 3, 5, 10, 15, 30, 45];
const TIMES = [
  "6:00",
  "7:00",
  "8:00",
  "9:00",
  "12:00",
  "15:00",
  "18:00",
  "21:00",
];

function DemoMascot({
  shape,
  color,
  size,
  online = false,
}: {
  shape?: string;
  color?: string;
  size: number;
  online?: boolean;
}) {
  const id = shape ?? "strobi";
  return (
    <span className="product-demo__mascot" style={{ width: size, height: size }} aria-hidden="true">
      <AgentMark
        color={
          color ?? MARK_STYLE_COLORS[id as keyof typeof MARK_STYLE_COLORS] ?? MARK_STYLE_COLORS.strobi
        }
        shape={id}
        size={size}
        online={online}
      />
    </span>
  );
}

function demoShape(shape?: string): MarkShape {
  return (PICKER_SHAPES as readonly string[]).includes(shape ?? "")
    ? (shape as MarkShape)
    : "strobi";
}

const DEMO_UI = {
  en: {
    freqs: ["Every hour", "Every day", "Weekdays", "Every week", "Every month", "Interval", "Advanced"],
    units: ["minutes", "hours", "days"],
    onboard: [
      {
        q: "What do you want the most help with?",
        sub: "Pick the closest answer, or write your own.",
        opts: ["Inbox and email", "Slack and messages", "Code and repositories", "Research and writing", "A bit of everything"],
        ack: (answer: string) => `${answer.toLowerCase()} is one of my strengths.`,
      },
      {
        q: "How should I write?",
        sub: "I will follow this unless you ask for something different in a specific draft.",
        opts: ["Clear and short", "Warm and conversational", "Polished / formal", "Match my draft"],
        ack: (answer: string) => `Got it — ${answer.toLowerCase()}.`,
      },
      {
        q: "Where does most of this work live?",
        sub: "So I know where to pull context from and leave drafts.",
        opts: ["Google Docs", "Notion", "Only in chat / paste it here", "A mix"],
        ack: (answer: string) => `Noted. I will pull from ${answer} and leave the drafts there too.`,
      },
    ],
    now: "Now",
    today: "Today",
    noSchedule: "No schedule",
    unnamedRoutine: "Untitled routine",
    botPreview: "Tell this bot what it should do",
    idleComputer: "Computer idle",
    botReply: "on it. hand me the work and I will get started.",
    working: "working…",
    hello: "Hi Iara — good to meet you.",
    ownAnswer: "Write your own answer",
    onboardingDone: "That is everything I need. Hand me a first job whenever you are ready — I will ask before anything leaves here.",
    newBot: "New bot",
    search: "Search",
    computerToggle: "Open or close computer",
    computer: "Computer",
    emptyThread: (name: string) => `Send ${name} a message and hand off the first job.`,
    messageFor: (name: string) => `Message ${name}`,
    send: "Send",
    settings: "settings",
    computerOf: (name: string) => `${name}'s computer`,
    botSettings: "Bot settings",
    closePanel: "Close panel",
    openComputer: "Open computer",
    takeControlComputer: "Take control of the computer",
    youHaveControl: "You have control",
    screenOf: (name: string) => `${name}'s screen`,
    release: "Release",
    takeControl: "Take control",
    routines: "Routines",
    routinesEmpty: "Routines are recurring tasks this bot runs on schedule.",
    createRoutine: "Create routine",
    newRoutine: "+ New routine",
    name: "Name",
    namePlaceholder: "Give this bot a name",
    role: "Role",
    rolePlaceholder: "Describe what this bot does",
    description: "Description",
    descriptionPlaceholder: "What this bot is for",
    character: "Character",
    characterHint: "How this bot's mark appears everywhere.",
    routine: "Routine",
    backToComputer: "Back to computer",
    active: "Active",
    paused: "Paused",
    delete: "Delete",
    test: "Test",
    routineNamePlaceholder: "Give this routine a name",
    instruction: "Instruction",
    instructionPlaceholder: "What should this routine do every time it runs?",
    schedule: "When to run",
    addSchedule: "+ Add schedule",
    removeSchedule: "Remove schedule",
    every: "every",
    at: "at",
    addAnother: "+ Add another",
    history: "History",
    noRuns: "No runs yet",
    completed: "Completed",
    routineRan: "Routine ran",
    bootTitle: (name: string) => `Starting ${name}'s computer`,
    bootSteps: { 8: "Allocating a machine", 46: "Restoring the session", 82: "Opening the browser", 100: "Handing the screen to you" } as Record<number, string>,
    closeComputer: "Close computer",
    caption: "Live demo — choose a bot, open the computer, create a routine, or start a new chat.",
  },
  "pt-BR": {
    freqs: ["Toda hora", "Todo dia", "Dias úteis", "Toda semana", "Todo mês", "Intervalo", "Avançado"],
    units: ["minutos", "horas", "dias"],
    onboard: [
      {
        q: "No que você mais quer ajuda?",
        sub: "Escolha o mais próximo, ou escreva o seu.",
        opts: ["Inbox e e-mail", "Slack e mensagens", "Código e repos", "Pesquisa e escrita", "Um pouco de tudo"],
        ack: (answer: string) => `${answer.toLowerCase()} é um ponto forte pra mim.`,
      },
      {
        q: "Como você quer que eu escreva?",
        sub: "Vou seguir isso, salvo quando você pedir outra coisa num texto específico.",
        opts: ["Claro e curto", "Quente e conversado", "Polido / formal", "Combinar com o que eu rascunhar"],
        ack: (answer: string) => `Fechado — ${answer.toLowerCase()}.`,
      },
      {
        q: "Onde mora a maior parte desse trabalho?",
        sub: "Pra eu saber de onde puxar e onde deixar os rascunhos.",
        opts: ["Google Docs", "Notion", "Só no chat / cola aqui", "Uma mistura"],
        ack: (answer: string) => `Anotado. Vou puxar de ${answer} e deixar os rascunhos lá também.`,
      },
    ],
    now: "Agora",
    today: "Hoje",
    noSchedule: "Sem horário",
    unnamedRoutine: "Rotina sem nome",
    botPreview: "Diz o que esse bot deve fazer",
    idleComputer: "Computador parado",
    botReply: "tô nisso. me passa o trabalho e eu começo.",
    working: "trabalhando…",
    hello: "Oi Iara — bom te conhecer.",
    ownAnswer: "Escreva a sua resposta",
    onboardingDone: "É tudo que eu preciso. Me passa um primeiro trabalho quando quiser — eu pergunto antes de qualquer coisa sair daqui.",
    newBot: "Novo bot",
    search: "Buscar",
    computerToggle: "Abrir ou fechar o computador",
    computer: "Computador",
    emptyThread: (name: string) => `Manda uma mensagem para ${name} e dá o primeiro trabalho.`,
    messageFor: (name: string) => `Mensagem para ${name}`,
    send: "Enviar",
    settings: "ajustes",
    computerOf: (name: string) => `computador de ${name}`,
    botSettings: "Ajustes do bot",
    closePanel: "Fechar painel",
    openComputer: "Abrir computador",
    takeControlComputer: "Assumir controle do computador",
    youHaveControl: "Você tem o controle",
    screenOf: (name: string) => `tela de ${name}`,
    release: "Liberar",
    takeControl: "Assumir controle",
    routines: "Rotinas",
    routinesEmpty: "Rotinas são tarefas recorrentes que este bot roda no horário.",
    createRoutine: "Criar rotina",
    newRoutine: "+ Nova rotina",
    name: "Nome",
    namePlaceholder: "Dê um nome a este bot",
    role: "Cargo",
    rolePlaceholder: "Descreva o que este bot faz",
    description: "Descrição",
    descriptionPlaceholder: "Pra que serve este bot",
    character: "Personagem",
    characterHint: "Como a marca deste bot aparece em todo lugar.",
    routine: "Rotina",
    backToComputer: "Voltar ao computador",
    active: "Ativa",
    paused: "Pausada",
    delete: "Excluir",
    test: "Testar",
    routineNamePlaceholder: "Dê um nome a esta rotina",
    instruction: "Instrução",
    instructionPlaceholder: "O que esta rotina deve fazer cada vez que rodar?",
    schedule: "Quando rodar",
    addSchedule: "+ Adicionar horário",
    removeSchedule: "Remover horário",
    every: "a cada",
    at: "às",
    addAnother: "+ Adicionar outro",
    history: "Histórico",
    noRuns: "Nenhuma execução ainda",
    completed: "Concluído",
    routineRan: "Rotina rodou",
    bootTitle: (name: string) => `Ligando o computador de ${name}`,
    bootSteps: { 8: "Alocando uma máquina", 46: "Restaurando a sessão", 82: "Abrindo o navegador", 100: "Passando a tela pra você" } as Record<number, string>,
    closeComputer: "Fechar computador",
    caption: "Demo ao vivo — escolha um bot, abra o computador, crie uma rotina ou comece um chat novo.",
  },
} as const;

type ExtraMessages = Record<string, DemoMessage[]>;
type PanelMode = "computer" | "settings" | "routine";
type LiveBot = DemoBot & {
  title: string;
  description: string;
  onboarding: boolean;
  answers: string[];
};
type Trigger = { freq: string; n: number; unit: string; time: string; cron: string };
type Run = { mark: string; color: string; text: string; time: string };
type RoutineDraft = {
  index: number | null;
  name: string;
  instruction: string;
  active: boolean;
  triggers: Trigger[];
  runs: Run[];
};

function cloneBots(locale: Locale): LiveBot[] {
  const source = locale === "en" ? DEMO_BOTS_EN : DEMO_BOTS;
  return source.map((bot) => ({
    ...bot,
    routines: bot.routines.map((routine) => ({ ...routine })),
    title: "",
    description: "",
    onboarding: false,
    answers: [],
  }));
}

function defaultTrigger(locale: Locale): Trigger {
  const ui = DEMO_UI[locale];
  return { freq: ui.freqs[1], n: 3, unit: ui.units[0], time: "9:00", cron: "" };
}

function parseWhen(when: string, locale: Locale): Trigger {
  const ui = DEMO_UI[locale];
  const trigger = defaultTrigger(locale);
  if (!when) {
    return trigger;
  }
  const interval = /(?:every|a cada)\s+(\d+)\s*(min|h)/i.exec(when);
  if (interval) {
    trigger.freq = ui.freqs[5];
    trigger.n = Number(interval[1]);
    trigger.unit = /h/i.test(interval[2] ?? "") ? ui.units[1] : ui.units[0];
    return trigger;
  }
  if (/hourly|toda hora/i.test(when)) {
    trigger.freq = ui.freqs[0];
    return trigger;
  }
  if (/weekday|dias úteis/i.test(when)) {
    trigger.freq = ui.freqs[2];
  } else if (/monday|segunda|week|semana/i.test(when)) {
    trigger.freq = ui.freqs[3];
  } else if (/month|mês/i.test(when)) {
    trigger.freq = ui.freqs[4];
  }
  const time = /(\d{1,2})(?::(\d{2}))?\s*(am|pm|h)?/i.exec(when);
  if (time) {
    trigger.time = `${time[1]}:${time[2] || "00"}`;
  }
  return trigger;
}

function describeTrigger(trigger: Trigger, locale: Locale) {
  const ui = DEMO_UI[locale];
  if (trigger.freq === ui.freqs[5]) {
    return { lead: locale === "en" ? "Every" : "A cada", detail: `${trigger.n} ${trigger.unit}` };
  }
  if (trigger.freq === ui.freqs[0]) {
    return { lead: ui.freqs[0], detail: "" };
  }
  if (trigger.freq === ui.freqs[6]) {
    return { lead: "Cron", detail: trigger.cron || "*/3 * * * *" };
  }
  if (trigger.freq === ui.freqs[2]) {
    return { lead: ui.freqs[2], detail: `${ui.at} ${trigger.time}` };
  }
  if (trigger.freq === ui.freqs[3]) {
    return { lead: locale === "en" ? "Every Monday" : "Toda segunda", detail: `${ui.at} ${trigger.time}` };
  }
  if (trigger.freq === ui.freqs[4]) {
    return {
      lead: ui.freqs[4],
      detail: locale === "en" ? `on day 1 at ${trigger.time}` : `no dia 1 às ${trigger.time}`,
    };
  }
  return { lead: ui.freqs[1], detail: `${ui.at} ${trigger.time}` };
}

function whenLabel(triggers: Trigger[], locale: Locale) {
  const ui = DEMO_UI[locale];
  if (triggers.length === 0) {
    return ui.noSchedule;
  }
  const { lead, detail } = describeTrigger(triggers[0] ?? defaultTrigger(locale), locale);
  return [lead, detail].filter(Boolean).join(" ");
}

function previewForBot(bot: LiveBot, extra: ExtraMessages) {
  const last = extra[bot.id]?.at(-1);
  if (last && "text" in last) {
    return last.text;
  }
  if (bot.onboarding && bot.answers.length > 0) {
    return bot.answers.at(-1) ?? bot.preview;
  }
  return bot.preview;
}

function ComputerPreview() {
  return (
    <img
      className="product-demo__screen-image"
      src="/computer-desktop-ice-blue.webp"
      alt=""
      draggable={false}
    />
  );
}

function Thread({ messages, working }: { messages: DemoMessage[]; working: string }) {
  return (
    <>
      {messages.map((message, index) => {
        if (message.type === "time") {
          return (
            <div key={`time-${index}`} className="product-demo__time">
              {message.text}
            </div>
          );
        }
        if (message.type === "meta") {
          return (
            <div key={`meta-${index}`} className="product-demo__meta">
              {message.text}
            </div>
          );
        }
        if (message.type === "card") {
          return (
            <div key={`card-${index}`} className="product-demo__message product-demo__message--bot">
              <div className="product-demo__card">
                {message.lines.map((line) => (
                  <div key={`${line.k}-${line.v}`} className="product-demo__card-line">
                    <span className="product-demo__card-check">✓</span>
                    <strong>{line.k}</strong>
                    <span className="product-demo__card-arrow">→</span>
                    <span>{line.v}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        }
        if (message.type === "typing") {
          return (
            <div
              key={`typing-${index}`}
              className="product-demo__message product-demo__message--bot"
            >
              <div className="product-demo__bubble product-demo__bubble--typing">{working}</div>
            </div>
          );
        }
        return (
          <div
            key={`${message.type}-${index}`}
            className={`product-demo__message product-demo__message--${message.type}`}
          >
            <div className={`product-demo__bubble product-demo__bubble--${message.type}`}>
              {message.text}
            </div>
          </div>
        );
      })}
    </>
  );
}

function OnboardThread({
  answers,
  onAnswer,
  locale,
}: {
  answers: string[];
  onAnswer: (value: string) => void;
  locale: Locale;
}) {
  const ui = DEMO_UI[locale];
  return (
    <>
      <div className="product-demo__time">{ui.today}</div>
      <div className="product-demo__message product-demo__message--bot">
        <div className="product-demo__bubble product-demo__bubble--bot">{ui.hello}</div>
      </div>
      {ui.onboard.map((step, index) => {
        const answer = answers[index];
        if (answer !== undefined) {
          const letter = String.fromCharCode(
            65 + Math.max(0, (step.opts as readonly string[]).indexOf(answer)),
          );
          return (
            <div key={step.q}>
              <div className="product-demo__choice product-demo__choice--done">
                <div className="product-demo__choice-q">{step.q}</div>
                <div className="product-demo__choice-picked">
                  <span className="product-demo__choice-letter">{letter}</span>
                  <span>{answer}</span>
                  <span className="product-demo__choice-check">✓</span>
                </div>
              </div>
              <div className="product-demo__message product-demo__message--bot">
                <div className="product-demo__bubble product-demo__bubble--bot">
                  {step.ack(answer)}
                </div>
              </div>
            </div>
          );
        }
        if (answers.length !== index) {
          return null;
        }
        return (
          <div key={step.q} className="product-demo__choice">
            <div className="product-demo__choice-q">{step.q}</div>
            <div className="product-demo__choice-sub">{step.sub}</div>
            <div className="product-demo__choice-opts">
              {step.opts.map((opt, optIndex) => (
                <button key={opt} type="button" onClick={() => onAnswer(opt)}>
                  <span className="product-demo__choice-letter">
                    {String.fromCharCode(65 + optIndex)}
                  </span>
                  <span>{opt}</span>
                </button>
              ))}
            </div>
            <div className="product-demo__choice-own">{ui.ownAnswer}</div>
          </div>
        );
      })}
      {answers.length === ui.onboard.length ? (
        <div className="product-demo__message product-demo__message--bot">
          <div className="product-demo__bubble product-demo__bubble--bot">{ui.onboardingDone}</div>
        </div>
      ) : null}
    </>
  );
}

export function ProductDemo({ locale = "en" }: { locale?: Locale }) {
  const ui = DEMO_UI[locale];
  const [bots, setBots] = useState<LiveBot[]>(() => cloneBots(locale));
  const [activeId, setActiveId] = useState("inbox");
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelMode, setPanelMode] = useState<PanelMode>("computer");
  const [hasControl, setHasControl] = useState(false);
  const [takeover, setTakeover] = useState(false);
  const [bootPct, setBootPct] = useState(0);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [extra, setExtra] = useState<ExtraMessages>({});
  const [routineDraft, setRoutineDraft] = useState<RoutineDraft | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const timersRef = useRef<number[]>([]);
  const booting = bootPct > 0;

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 860px)");
    const collapse = () => {
      if (mq.matches) setPanelOpen(false);
    };
    collapse();
    mq.addEventListener("change", collapse);
    return () => mq.removeEventListener("change", collapse);
  }, []);

  const active = bots.find((bot) => bot.id === activeId) ?? bots[0];
  const messages = useMemo(() => {
    if (!active) {
      return [];
    }
    return active.thread.concat(extra[active.id] ?? []);
  }, [active, extra]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return bots;
    }
    return bots.filter((bot) => `${bot.name} ${bot.preview}`.toLowerCase().includes(needle));
  }, [bots, query]);

  const onboardingOpen = Boolean(active?.onboarding && active.answers.length < ui.onboard.length);

  useEffect(() => {
    setHasControl(false);
    setTakeover(false);
    setBootPct(0);
  }, [activeId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [active?.id, messages.length, active?.answers.length]);

  useEffect(() => {
    return () => {
      for (const timer of timersRef.current) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  useEffect(() => {
    if (!takeover && !booting) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setTakeover(false);
        setBootPct(0);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [takeover, booting]);

  if (!active) {
    return null;
  }

  function openComputer() {
    setPanelOpen(true);
    setPanelMode("computer");
    setRoutineDraft(null);
  }

  function toggleComputer() {
    if (panelOpen && panelMode === "computer") {
      setPanelOpen(false);
      return;
    }
    openComputer();
  }

  function openSettings() {
    setPanelOpen(true);
    setPanelMode("settings");
    setRoutineDraft(null);
  }

  function openRoutine(routine: DemoRoutine | null, index: number | null) {
    const nextIndex = index === null ? active.routines.length : index;
    if (index === null) {
      patchActive({
        routines: [...active.routines, { name: "", when: ui.noSchedule, instruction: "" }],
      });
    }
    setPanelOpen(true);
    setPanelMode("routine");
    setRoutineDraft({
      index: nextIndex,
      name: routine?.name ?? "",
      instruction: routine?.instruction ?? "",
      active: true,
      triggers: routine ? [parseWhen(routine.when, locale)] : [],
      runs: [],
    });
  }

  function patchActive(patch: Partial<LiveBot>) {
    setBots((current) => current.map((bot) => (bot.id === activeId ? { ...bot, ...patch } : bot)));
  }

  function changeRoutine(patch: Partial<RoutineDraft>) {
    setRoutineDraft((current) => {
      if (!current) {
        return current;
      }
      const next = { ...current, ...patch };
      setBots((bots) =>
        bots.map((bot) => {
          if (bot.id !== activeId) {
            return bot;
          }
          const routines = [...bot.routines];
          const item: DemoRoutine = {
            name: next.name.trim() || ui.unnamedRoutine,
            when: whenLabel(next.triggers, locale),
            instruction: next.instruction,
          };
          if (next.index === null) {
            next.index = routines.length;
            routines.push(item);
          } else {
            routines[next.index] = item;
          }
          return { ...bot, routines };
        }),
      );
      return next;
    });
  }

  function persistRoutine(draftState: RoutineDraft) {
    const next: DemoRoutine = {
      name: draftState.name.trim() || ui.unnamedRoutine,
      when: whenLabel(draftState.triggers, locale),
      instruction: draftState.instruction,
    };
    setBots((current) =>
      current.map((bot) => {
        if (bot.id !== activeId) {
          return bot;
        }
        const routines = [...bot.routines];
        if (draftState.index === null) {
          routines.push(next);
        } else {
          routines[draftState.index] = next;
        }
        return { ...bot, routines };
      }),
    );
  }

  function saveRoutine() {
    if (!routineDraft) {
      return;
    }
    persistRoutine(routineDraft);
    openComputer();
  }

  function deleteRoutine() {
    if (routineDraft?.index !== null && routineDraft) {
      patchActive({ routines: active.routines.filter((_, index) => index !== routineDraft.index) });
    }
    openComputer();
  }

  function startNewBot() {
    const shape = PICKER_SHAPES[bots.length % PICKER_SHAPES.length] ?? "strobi";
    const color = MARK_STYLE_COLORS[shape];
    const bot: LiveBot = {
      id: `bot-${Date.now()}`,
      name: "",
      color,
      shape,
      time: ui.now,
      preview: ui.botPreview,
      title: "",
      description: "",
      onboarding: true,
      answers: [],
      routines: [],
      screen: { host: "desktop", title: ui.idleComputer, lines: [] },
      thread: [],
      reply: ui.botReply,
    };
    setBots((current) => [bot, ...current]);
    setActiveId(bot.id);
    setDraft("");
    openSettings();
  }

  function answerOnboard(value: string) {
    if (!active.onboarding || active.answers.length >= ui.onboard.length) {
      return;
    }
    patchActive({ answers: [...active.answers, value] });
  }

  function closeOverlay() {
    for (const timer of timersRef.current.splice(0)) {
      window.clearTimeout(timer);
    }
    setTakeover(false);
    setBootPct(0);
  }

  function releaseControl() {
    setHasControl(false);
    closeOverlay();
  }

  function takeControl() {
    if (booting) {
      return;
    }
    if (hasControl) {
      setTakeover(true);
      return;
    }
    for (const timer of timersRef.current.splice(0)) {
      window.clearTimeout(timer);
    }
    setBootPct(8);
    const steps = [
      window.setTimeout(() => setBootPct(46), 450),
      window.setTimeout(() => setBootPct(82), 1100),
      window.setTimeout(() => setBootPct(100), 1750),
      window.setTimeout(() => {
        setBootPct(0);
        setHasControl(true);
        setTakeover(true);
      }, 2300),
    ];
    timersRef.current.push(...steps);
  }

  function appendMessage(botId: string, message: DemoMessage) {
    setExtra((current) => ({
      ...current,
      [botId]: [...(current[botId] ?? []), message],
    }));
  }

  function send() {
    const text = draft.trim();
    if (!text) {
      return;
    }
    setDraft("");
    if (onboardingOpen) {
      answerOnboard(text);
      return;
    }
    const botId = active.id;
    const reply = active.reply;
    appendMessage(botId, { type: "user", text });
    const typingTimer = window.setTimeout(() => appendMessage(botId, { type: "typing" }), 280);
    const replyTimer = window.setTimeout(() => {
      setExtra((current) => {
        const withoutTyping = (current[botId] ?? []).filter((message) => message.type !== "typing");
        return { ...current, [botId]: [...withoutTyping, { type: "bot", text: reply }] };
      });
    }, 1350);
    timersRef.current.push(typingTimer, replyTimer);
  }

  function selectBot(id: string) {
    setActiveId(id);
    if (panelMode === "routine") {
      setPanelMode("computer");
      setRoutineDraft(null);
    }
  }

  function patchTrigger(index: number, patch: Partial<Trigger>) {
    changeRoutine({
      triggers: (routineDraft?.triggers ?? []).map((trigger, triggerIndex) =>
        triggerIndex === index ? { ...trigger, ...patch } : trigger,
      ),
    });
  }

  function testRun() {
    if (!routineDraft?.name.trim()) {
      return;
    }
    persistRoutine(routineDraft);
    changeRoutine({
      runs: [
        ...routineDraft.runs,
        { mark: "●", color: "#4ECB71", text: ui.completed, time: ui.now },
      ],
    });
    appendMessage(active.id, { type: "meta", text: `${ui.routineRan} · ${routineDraft.name}` });
  }

  return (
    <div className="product-demo">
      <div className={`product-demo__frame${panelOpen ? "" : " is-collapsed"}`}>
        <aside className="product-demo__sidebar">
          <div className="product-demo__chrome">
            <div className="product-demo__traffic" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <button
              type="button"
              className="product-demo__new"
              aria-label={ui.newBot}
              onClick={startNewBot}
            >
              +
            </button>
          </div>
          <label className="product-demo__search">
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={ui.search}
            />
          </label>
          <div className="product-demo__bot-list">
            {filtered.map((bot) => {
              const isActive = bot.id === active.id;
              return (
                <button
                  key={bot.id}
                  type="button"
                  className={`product-demo__bot-row${isActive ? " is-active" : ""}`}
                  onClick={() => selectBot(bot.id)}
                >
                  <DemoMascot shape={bot.shape} color={bot.color} size={44} online={isActive} />
                  <span className="product-demo__bot-copy">
                    <span className="product-demo__bot-meta">
                      <span className="product-demo__bot-name">{bot.name}</span>
                      <span className="product-demo__bot-time">{bot.time}</span>
                    </span>
                    <span className="product-demo__bot-preview">{previewForBot(bot, extra)}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="product-demo__user">
            <span className="product-demo__user-badge">AK</span>
            <span>Iara Vale</span>
          </div>
        </aside>

        <main className="product-demo__main">
          <div className="product-demo__topbar">
            <button type="button" className="product-demo__name-btn" onClick={openSettings}>
              <DemoMascot shape={active.shape} color={active.color} size={24} />
              <span className="product-demo__active-name">{active.name}</span>
            </button>
            <button
              type="button"
              className="product-demo__panel-toggle"
              aria-pressed={panelOpen && panelMode === "computer"}
              aria-label={ui.computerToggle}
              title={ui.computer}
              onClick={toggleComputer}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <rect x="2" y="4" width="20" height="13" rx="2" />
                <path d="M8 21h8M12 17v4" />
              </svg>
            </button>
          </div>

          <div className="product-demo__thread" ref={scrollRef}>
            {active.onboarding ? (
              <OnboardThread answers={active.answers} onAnswer={answerOnboard} locale={locale} />
            ) : null}
            {messages.length === 0 && !active.onboarding ? (
              <div className="product-demo__empty-thread">{ui.emptyThread(active.name)}</div>
            ) : (
              <Thread messages={messages} working={ui.working} />
            )}
          </div>

          <div className="product-demo__composer">
            <div className="product-demo__input-shell">
              <span className="product-demo__composer-plus" aria-hidden="true">
                +
              </span>
              <input
                type="text"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    send();
                  }
                }}
                placeholder={onboardingOpen ? ui.ownAnswer : ui.messageFor(active.name)}
                aria-label={onboardingOpen ? ui.ownAnswer : ui.messageFor(active.name)}
              />
              <button type="button" className="product-demo__send" onClick={send} aria-label={ui.send}>
                ↑
              </button>
            </div>
          </div>
        </main>

        {panelOpen ? (
          <aside className="product-demo__panel">
            {panelMode !== "routine" ? (
              <div className="product-demo__panel-head">
                <span>{panelMode === "settings" ? ui.settings : ui.computerOf(active.name)}</span>
                <div className="product-demo__panel-actions">
                  <button type="button" aria-label={ui.botSettings} onClick={openSettings}>
                    <svg
                      width="17"
                      height="17"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                    >
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    aria-label={ui.closePanel}
                    onClick={() => setPanelOpen(false)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ) : null}

            {panelMode === "computer" ? (
              <>
                <button
                  type="button"
                  className="product-demo__screen"
                  onClick={takeControl}
                  aria-label={hasControl ? ui.openComputer : ui.takeControlComputer}
                >
                  <ComputerPreview />
                </button>
                <div className="product-demo__screen-meta">
                  <span>{hasControl ? ui.youHaveControl : ui.screenOf(active.name)}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => (hasControl ? releaseControl() : takeControl())}
                  >
                    {hasControl ? ui.release : ui.takeControl}
                  </Button>
                </div>
                <div className="product-demo__panel-label">{ui.routines}</div>
                {active.routines.length === 0 ? (
                  <div className="product-demo__empty-routines">
                    <p>{ui.routinesEmpty}</p>
                    <button
                      type="button"
                      className="product-demo__ghost-btn"
                      onClick={() => openRoutine(null, null)}
                    >
                      {ui.createRoutine}
                    </button>
                  </div>
                ) : (
                  <>
                    {active.routines.map((routine, index) => (
                      <button
                        key={`${routine.name}-${index}`}
                        type="button"
                        className="product-demo__routine"
                        onClick={() => openRoutine(routine, index)}
                      >
                        <span className="product-demo__routine-icon">◷</span>
                        <span className="product-demo__routine-name">{routine.name}</span>
                        <span className="product-demo__routine-when">{routine.when}</span>
                      </button>
                    ))}
                    <button
                      type="button"
                      className="product-demo__quiet"
                      onClick={() => openRoutine(null, null)}
                    >
                      {ui.newRoutine}
                    </button>
                  </>
                )}
              </>
            ) : null}

            {panelMode === "settings" ? (
              <div className="product-demo__settings">
                <div className="product-demo__settings-avatar">
                  <DemoMascot shape={active.shape} color={active.color} size={88} />
                </div>
                <label className="product-demo__field">
                  {ui.name}
                  <input
                    value={active.name}
                    placeholder={ui.namePlaceholder}
                    onChange={(event) => patchActive({ name: event.target.value })}
                  />
                </label>
                <label className="product-demo__field">
                  {ui.role}
                  <input
                    value={active.title}
                    placeholder={ui.rolePlaceholder}
                    onChange={(event) => patchActive({ title: event.target.value })}
                  />
                </label>
                <label className="product-demo__field">
                  {ui.description}
                  <textarea
                    rows={4}
                    value={active.description}
                    placeholder={ui.descriptionPlaceholder}
                    onChange={(event) => patchActive({ description: event.target.value })}
                  />
                </label>
                <p className="product-demo__section-label">{ui.character}</p>
                <CharacterPicker
                  color={active.color}
                  shape={demoShape(active.shape)}
                  onChange={(next) => patchActive({ color: next.color, shape: next.shape })}
                />
                <p className="product-demo__hint">{ui.characterHint}</p>
              </div>
            ) : null}

            {panelMode === "routine" && routineDraft ? (
              <div className="product-demo__routine-editor">
                <div className="product-demo__routine-nav">
                  <button type="button" onClick={saveRoutine} aria-label={ui.backToComputer}>
                    ‹
                  </button>
                  <span>{ui.routine}</span>
                  <button
                    type="button"
                    onClick={() => setPanelOpen(false)}
                    aria-label={ui.closePanel}
                  >
                    ✕
                  </button>
                </div>
                <div className="product-demo__routine-toolbar">
                  <button
                    type="button"
                    className={`product-demo__switch${routineDraft.active ? " is-on" : ""}`}
                    aria-pressed={routineDraft.active}
                    onClick={() => changeRoutine({ active: !routineDraft.active })}
                  >
                    <span />
                  </button>
                  <span>{routineDraft.active ? ui.active : ui.paused}</span>
                  <button type="button" className="product-demo__ghost-btn" onClick={deleteRoutine}>
                    {ui.delete}
                  </button>
                  <button
                    type="button"
                    className="product-demo__ghost-btn"
                    disabled={!routineDraft.name.trim()}
                    onClick={testRun}
                  >
                    {ui.test}
                  </button>
                </div>
                <label className="product-demo__field">
                  {ui.name}
                  <input
                    value={routineDraft.name}
                    placeholder={ui.routineNamePlaceholder}
                    onChange={(event) => changeRoutine({ name: event.target.value })}
                  />
                </label>
                <label className="product-demo__field">
                  {ui.instruction}
                  <textarea
                    rows={4}
                    value={routineDraft.instruction}
                    placeholder={ui.instructionPlaceholder}
                    onChange={(event) => changeRoutine({ instruction: event.target.value })}
                  />
                </label>
                <div className="product-demo__field">
                  {ui.schedule}
                  {routineDraft.triggers.length === 0 ? (
                    <button
                      type="button"
                      className="product-demo__add-schedule"
                      onClick={() => changeRoutine({ triggers: [defaultTrigger(locale)] })}
                    >
                      {ui.addSchedule}
                    </button>
                  ) : (
                    <div className="product-demo__triggers">
                      {routineDraft.triggers.map((trigger, index) => {
                        const { lead, detail } = describeTrigger(trigger, locale);
                        const timed = ui.freqs.slice(1, 5).includes(trigger.freq as never);
                        return (
                          <div key={`${trigger.freq}-${index}`} className="product-demo__trigger">
                            <div className="product-demo__trigger-head">
                              <span>
                                {lead} {detail}
                              </span>
                              <button
                                type="button"
                                aria-label={ui.removeSchedule}
                                onClick={() =>
                                  changeRoutine({
                                    triggers: routineDraft.triggers.filter(
                                      (_, triggerIndex) => triggerIndex !== index,
                                    ),
                                  })
                                }
                              >
                                ✕
                              </button>
                            </div>
                            <div className="product-demo__trigger-row">
                              <select
                                value={trigger.freq}
                                onChange={(event) =>
                                  patchTrigger(index, { freq: event.target.value })
                                }
                              >
                                {ui.freqs.map((freq) => (
                                  <option key={freq} value={freq}>
                                    {freq}
                                  </option>
                                ))}
                              </select>
                              {trigger.freq === ui.freqs[5] ? (
                                <>
                                  <span>{ui.every}</span>
                                  <select
                                    value={String(trigger.n)}
                                    onChange={(event) =>
                                      patchTrigger(index, { n: Number(event.target.value) })
                                    }
                                  >
                                    {NUMBERS.map((n) => (
                                      <option key={n} value={n}>
                                        {n}
                                      </option>
                                    ))}
                                  </select>
                                  <select
                                    value={trigger.unit}
                                    onChange={(event) =>
                                      patchTrigger(index, { unit: event.target.value })
                                    }
                                  >
                                    {ui.units.map((unit) => (
                                      <option key={unit} value={unit}>
                                        {unit}
                                      </option>
                                    ))}
                                  </select>
                                </>
                              ) : null}
                              {timed ? (
                                <>
                                  <span>{ui.at}</span>
                                  <select
                                    value={trigger.time}
                                    onChange={(event) =>
                                      patchTrigger(index, { time: event.target.value })
                                    }
                                  >
                                    {TIMES.map((time) => (
                                      <option key={time} value={time}>
                                        {time}
                                      </option>
                                    ))}
                                  </select>
                                </>
                              ) : null}
                              {trigger.freq === ui.freqs[6] ? (
                                <input
                                  value={trigger.cron}
                                  placeholder="*/3 * * * *"
                                  onChange={(event) =>
                                    patchTrigger(index, { cron: event.target.value })
                                  }
                                />
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                      <button
                        type="button"
                        className="product-demo__quiet"
                        onClick={() =>
                          changeRoutine({ triggers: [...routineDraft.triggers, defaultTrigger(locale)] })
                        }
                      >
                        {ui.addAnother}
                      </button>
                    </div>
                  )}
                </div>
                <div className="product-demo__field">
                  {ui.history}
                  {routineDraft.runs.length === 0 ? (
                    <p className="product-demo__muted">{ui.noRuns}</p>
                  ) : (
                    <ul className="product-demo__runs">
                      {routineDraft.runs.map((run, index) => (
                        <li key={`${run.text}-${index}`}>
                          <span style={{ color: run.color }}>{run.mark}</span>
                          <span>{run.text}</span>
                          <span>{run.time}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ) : null}
          </aside>
        ) : null}

        {booting || takeover ? (
          <div className="product-demo__stage">
            {booting ? (
              <div className="product-demo__boot">
                <div className="product-demo__boot-title">{ui.bootTitle(active.name)}</div>
                <div className="product-demo__boot-track">
                  <div style={{ width: `${bootPct}%` }} />
                </div>
                <div className="product-demo__boot-step">{ui.bootSteps[bootPct] ?? ""}</div>
              </div>
            ) : (
              <div className="product-demo__takeover">
                <div className="product-demo__takeover-bar">
                  <div className="product-demo__takeover-who">
                    <DemoMascot shape={active.shape} color={active.color} size={28} />
                    <span>{ui.computerOf(active.name)}</span>
                    <span className="product-demo__takeover-pill">{ui.youHaveControl}</span>
                  </div>
                  <div className="product-demo__takeover-actions">
                    <Button type="button" variant="outline" size="sm" onClick={releaseControl}>
                      {ui.release}
                    </Button>
                    <button
                      type="button"
                      className="product-demo__takeover-close"
                      onClick={closeOverlay}
                      aria-label={ui.closeComputer}
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <div className="product-demo__takeover-screen">
                  <ComputerPreview />
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
      <p className="product-demo__caption">{ui.caption}</p>
    </div>
  );
}
