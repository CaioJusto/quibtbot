import type { MobileBot, MobileGroupMember, MobileMessage } from "./api";
import { bundledWithPrevious, chatTimeLabel, shouldShowTimeStamp } from "./chat";

/** "tool" offers Recusar/Sempre/Permitir; "tool-once" drops Sempre (the server would not honour it). */
export type ApprovalKind = "tool" | "tool-once" | "message" | null;

/** Which approval buttons a bubble needs: none once the ask was answered. */
export function approvalKind(message: MobileMessage): ApprovalKind {
  const ask = message.blocks.find((block) => block.kind === "ask");
  if (!ask || !message.runId || ask.answered) return null;
  if (!ask.tool) return "message";
  // Cards antigos não traziam `actions`; neles o "Sempre" valia sempre que havia allowKey.
  const offersAlways = ask.actions
    ? ask.actions.some((action) => action.id === "always")
    : Boolean(ask.allowKey);
  return offersAlways ? "tool" : "tool-once";
}

export type ThreadRow = {
  /** Stable across renders and reconnections: it is the message id the server gave us. */
  key: string;
  message: MobileMessage;
  mine: boolean;
  bundled: boolean;
  stamp: string | null;
  from: string | null;
  authorName?: string;
  authorColor?: string;
  authorShape?: string;
  showAuthorMark: boolean;
  approval: ApprovalKind;
  answerBotId?: string;
};

/**
 * Everything a bubble needs, computed once per thread instead of inside the list render.
 * A virtualized list only renders what is on screen, so the neighbour-dependent bits
 * (bundling, day stamps, "last of the bundle") cannot be derived from the visible slice —
 * they are resolved here, over the whole thread.
 */
export type BuildThreadRowsInput = {
  messages: readonly MobileMessage[];
  botId?: string;
  bots: readonly MobileBot[];
  members: readonly MobileGroupMember[];
  isGroup: boolean;
  now?: Date;
};

export function buildThreadRows(input: BuildThreadRowsInput): ThreadRow[] {
  const { messages, botId, bots, members, isGroup } = input;
  const now = input.now ?? new Date();
  const botNames = new Map(bots.map((bot) => [bot.id, bot.name]));
  const membersById = new Map(members.map((member) => [member.id, member]));
  return messages.map((message, index) => {
    const prev = messages[index - 1];
    const next = messages[index + 1];
    const bundled = bundledWithPrevious(prev, message);
    const stamp = shouldShowTimeStamp(prev, message) ? chatTimeLabel(message.createdAt, now) : null;
    const peerId = message.fromBotId;
    const from =
      bundled || isGroup || !peerId || peerId === botId
        ? null
        : `Mensagem de ${botNames.get(peerId) ?? "outro bot"}`;
    const mine = message.role === "user" && !message.fromBotId;
    const author = isGroup && !mine ? membersById.get(message.authorBotId ?? "") : undefined;
    const lastOfBundle = !next || !bundledWithPrevious(message, next);
    return {
      key: message.id,
      message,
      mine,
      bundled,
      stamp,
      from,
      authorName: author?.name,
      authorColor: author?.color,
      authorShape: author?.shape,
      showAuthorMark: Boolean(isGroup && !mine && lastOfBundle && author),
      approval: approvalKind(message),
      answerBotId: message.authorBotId ?? botId,
    };
  });
}

export function reconcileThreadRows(
  previous: readonly ThreadRow[],
  input: BuildThreadRowsInput,
): ThreadRow[] {
  const previousByKey = new Map(previous.map((row) => [row.key, row]));
  return buildThreadRows(input).map((next) => {
    const current = previousByKey.get(next.key);
    return current && sameThreadRow(current, next) ? current : next;
  });
}

function sameThreadRow(previous: ThreadRow, next: ThreadRow) {
  return (
    previous.message === next.message &&
    previous.mine === next.mine &&
    previous.bundled === next.bundled &&
    previous.stamp === next.stamp &&
    previous.from === next.from &&
    previous.authorName === next.authorName &&
    previous.authorColor === next.authorColor &&
    previous.authorShape === next.authorShape &&
    previous.showAuthorMark === next.showAuthorMark &&
    previous.approval === next.approval &&
    previous.answerBotId === next.answerBotId
  );
}

/**
 * The list only follows new messages when the user is already at the bottom; scrolled up
 * to read, it must stay where it is.
 */
export const STICK_TO_BOTTOM_SLACK = 80;

export function isNearBottom(
  event: {
    contentOffset: { y: number };
    contentSize: { height: number };
    layoutMeasurement: { height: number };
  },
  slack = STICK_TO_BOTTOM_SLACK,
) {
  const distance =
    event.contentSize.height - (event.contentOffset.y + event.layoutMeasurement.height);
  return distance < slack;
}
