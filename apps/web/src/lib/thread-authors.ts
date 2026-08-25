import type { ThreadMessage } from "@quibt/contracts";

export type MessageAuthor = { id: string; name: string; color: string; shape?: string | null };

const UNKNOWN_COLOR = "#3A3A40";

/** In a 1:1 thread, a message carrying `fromBotId` was written by another bot, not by the user. */
export function peerAuthor(
  message: Pick<ThreadMessage, "fromBotId">,
  selfBotId: string | undefined,
  bots: MessageAuthor[],
): MessageAuthor | null {
  const id = message.fromBotId;
  if (!id || id === selfBotId) return null;
  return resolve(id, bots);
}

/** In a group thread, `authorBotId` says which member spoke. */
export function groupAuthor(
  message: Pick<ThreadMessage, "authorBotId" | "fromBotId">,
  members: MessageAuthor[],
): MessageAuthor | null {
  const id = message.authorBotId ?? message.fromBotId;
  if (!id) return null;
  return resolve(id, members);
}

/**
 * The bot behind the most recent peer message, for the "Message from {peer}" chip
 * under the chat title. Anything the user or this bot wrote clears it.
 */
export function latestPeerPing(
  messages: Array<Pick<ThreadMessage, "role" | "fromBotId">>,
  selfBotId: string | undefined,
  bots: MessageAuthor[],
): MessageAuthor | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === "user") return null;
    const peer = peerAuthor(message, selfBotId, bots);
    if (peer) return peer;
  }
  return null;
}

function resolve(id: string, candidates: MessageAuthor[]): MessageAuthor {
  const found = candidates.find((candidate) => candidate.id === id);
  return {
    id,
    name: found?.name ?? "Another bot",
    color: found?.color ?? UNKNOWN_COLOR,
    ...(found?.shape ? { shape: found.shape } : {}),
  };
}
