export type ChatSpeaker = {
  id: string;
  role: string;
  fromBotId?: string;
  authorBotId?: string;
  createdAt?: string;
};

export type ChatBot = { id: string; name: string };

export type ChatMessage = {
  id: string;
  role: "user" | "bot" | "system";
  parentId?: string | null;
  replyToId?: string;
  reactions?: Record<string, string[]>;
  blocks: Array<{ kind: string; text?: string }>;
  createdAt?: string;
  fromBotId?: string;
};

export type OptimisticAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  image?: boolean;
};

/**
 * Draws the person's message before the network round-trip finishes. The nonce is also
 * sent to the server and echoed in the live event, so the durable row replaces this one
 * instead of briefly drawing the same message twice.
 */
export function buildOptimisticUserMessage(input: {
  clientNonce: string;
  text: string;
  attachments?: readonly OptimisticAttachment[];
  replyToId?: string;
  createdAt?: string;
}): ChatMessage & { clientNonce: string } {
  return {
    id: `optimistic:${input.clientNonce}`,
    clientNonce: input.clientNonce,
    role: "user",
    blocks: [
      { kind: "text", text: input.text },
      ...(input.attachments ?? []).map((file) => ({
        kind: "file",
        artifactId: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        image: file.image,
      })),
    ],
    replyToId: input.replyToId,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export const LOCAL_REACTOR_ID = "__local__";

export type MessageActionKind = "reply" | "react" | "edit" | "branch-prev" | "branch-next" | "copy";

export type MessageAction = {
  kind: MessageActionKind;
  label: string;
};

type VersionRow = { id: string; parentId?: string | null; role: string };

function versionKey(message: VersionRow) {
  return `${message.role}\u0000${message.parentId ?? ""}`;
}

export function versionsByParent<T extends VersionRow>(messages: readonly T[]): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const message of messages) {
    const key = versionKey(message);
    const siblings = index.get(key);
    if (siblings) siblings.push(message);
    else index.set(key, [message]);
  }
  return index;
}

export function versionsOf<T extends VersionRow>(index: Map<string, T[]>, message: T): T[] {
  return index.get(versionKey(message)) ?? [];
}

export function quotedTextFor(
  messages: readonly ChatMessage[],
  replyToId?: string,
): string | undefined {
  if (!replyToId) return undefined;
  const source = messages.find((row) => row.id === replyToId);
  if (!source) return undefined;
  const text = source.blocks
    .map((block) => (block.kind === "text" && block.text ? block.text : ""))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

export function buildReactPayload(input: { botId: string; messageId: string; emoji: string }) {
  return { botId: input.botId, messageId: input.messageId, emoji: input.emoji };
}

export function buildEditPayload(input: { botId: string; messageId: string; text: string }) {
  return { botId: input.botId, messageId: input.messageId, text: input.text };
}

export function buildSwitchBranchPayload(input: { botId: string; messageId: string }) {
  return { botId: input.botId, messageId: input.messageId };
}

export function messageActions(input: {
  message: ChatMessage;
  isGroup: boolean;
  working: boolean;
  versionIndex?: number;
  versionCount?: number;
}): MessageAction[] {
  const actions: MessageAction[] = [];
  const text = input.message.blocks.find((block) => block.kind === "text")?.text ?? "";
  if (text) actions.push({ kind: "copy", label: "Copiar" });
  if (!input.isGroup) {
    actions.push({ kind: "reply", label: "Responder" });
    if (input.message.role !== "user") {
      actions.push({ kind: "react", label: "Reagir" });
    }
    if (input.message.role === "user" && !input.working && !input.message.fromBotId) {
      actions.push({ kind: "edit", label: "Editar" });
    }
    if ((input.versionCount ?? 0) > 1) {
      if ((input.versionIndex ?? 0) > 0) {
        actions.push({ kind: "branch-prev", label: "Versão anterior" });
      }
      if ((input.versionIndex ?? 0) + 1 < (input.versionCount ?? 0)) {
        actions.push({ kind: "branch-next", label: "Próxima versão" });
      }
    }
  }
  return actions;
}

export function applyOptimisticReaction<T extends ChatMessage>(
  messages: readonly T[],
  messageId: string,
  emoji: string,
  reactorId = LOCAL_REACTOR_ID,
): T[] {
  return messages.map((message) => {
    if (message.id !== messageId) return message;
    const reactions = { ...(message.reactions ?? {}) };
    const who = reactions[emoji] ?? [];
    if (who.includes(reactorId)) {
      const next = who.filter((id) => id !== reactorId);
      if (next.length) reactions[emoji] = next;
      else delete reactions[emoji];
    } else {
      reactions[emoji] = [...who, reactorId];
    }
    return { ...message, reactions };
  });
}

export function rollbackMessages<T>(_current: readonly T[], snapshot: readonly T[]): T[] {
  return [...snapshot];
}

function speakerKey(message: ChatSpeaker) {
  return message.fromBotId || message.authorBotId || message.role;
}

/** Consecutive bubbles from the same speaker can sit tighter together. */
export function bundledWithPrevious(prev: ChatSpeaker | undefined, message: ChatSpeaker) {
  if (!prev) return false;
  return speakerKey(prev) === speakerKey(message);
}

export function dayKey(iso?: string) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Stamp central: "Hoje HH:mm" no mesmo dia, "Ontem HH:mm" no dia anterior,
 * senão data curta + hora.
 */
export function inboxTimeLabel(iso: string | undefined, now = new Date()): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  if (dayKey(iso) === dayKey(now.toISOString())) return `${hh}:${mm}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return "Ontem";
  const months = [
    "jan",
    "fev",
    "mar",
    "abr",
    "mai",
    "jun",
    "jul",
    "ago",
    "set",
    "out",
    "nov",
    "dez",
  ];
  return `${months[date.getMonth()]} ${date.getDate()}`;
}

export function chatTimeLabel(iso: string | undefined, now = new Date()): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const time = `${hh}:${mm}`;
  if (dayKey(iso) === dayKey(now.toISOString())) return `Hoje ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return `Ontem ${time}`;
  const months = [
    "jan",
    "fev",
    "mar",
    "abr",
    "mai",
    "jun",
    "jul",
    "ago",
    "set",
    "out",
    "nov",
    "dez",
  ];
  return `${months[date.getMonth()]} ${date.getDate()} ${time}`;
}

export function shouldShowTimeStamp(prev: ChatSpeaker | undefined, message: ChatSpeaker) {
  if (!message.createdAt) return false;
  if (!prev?.createdAt) return true;
  return dayKey(prev.createdAt) !== dayKey(message.createdAt);
}

export function peerLine(
  message: ChatSpeaker,
  selfBotId: string | undefined,
  bots: readonly ChatBot[],
): string | null {
  const id = message.fromBotId;
  if (!id || id === selfBotId) return null;
  const name = bots.find((bot) => bot.id === id)?.name ?? "outro bot";
  return `Mensagem de ${name}`;
}
