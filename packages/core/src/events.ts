import type { MessageBlock, ThreadMessage } from "@quibt/contracts";

export function projectMessages(
  events: Array<{
    seq: number;
    type: string;
    payload: unknown;
    runId?: string | null;
    createdAt: Date | string;
    id: string;
    threadId: string;
  }>,
): ThreadMessage[] {
  const messages: ThreadMessage[] = [];
  let streaming: ThreadMessage | null = null;
  const liveSubagents = new Map<string, ThreadMessage>();
  const durableSubagents = new Set<string>();
  for (const event of events) {
    const payload = asRecord(event.payload);
    const createdAt =
      typeof event.createdAt === "string" ? event.createdAt : event.createdAt.toISOString();
    if (event.type === "thread.message.created") {
      streaming = null;
      const role = (payload.role as ThreadMessage["role"]) ?? "bot";
      const blocks = (payload.blocks as MessageBlock[]) ?? [];
      for (const block of blocks) {
        if (block.kind === "subagent") {
          durableSubagents.add(block.agentId);
          liveSubagents.delete(block.agentId);
        }
      }
      messages.push({
        id: (payload.messageId as string) ?? event.id,
        threadId: event.threadId,
        seq: event.seq,
        role,
        blocks,
        runId: event.runId ?? undefined,
        fromBotId: typeof payload.fromBotId === "string" ? payload.fromBotId : undefined,
        authorBotId: typeof payload.authorBotId === "string" ? payload.authorBotId : undefined,
        createdAt,
      });
      continue;
    }
    if (event.type === "thread.progress") {
      const text = String(payload.text ?? "");
      streaming = {
        id: `progress:${event.runId ?? event.id}`,
        threadId: event.threadId,
        seq: event.seq,
        role: "bot",
        blocks: [{ kind: "progress", text }],
        runId: event.runId ?? undefined,
        createdAt,
      };
      continue;
    }
    if (event.type === "thread.subagent") {
      const block = subagentBlockFromPayload(payload);
      if (durableSubagents.has(block.agentId)) continue;
      liveSubagents.set(block.agentId, {
        id: `subagent:${block.agentId}`,
        threadId: event.threadId,
        seq: event.seq,
        role: "bot",
        blocks: [block],
        runId: event.runId ?? undefined,
        createdAt,
      });
      continue;
    }
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
    ) {
      streaming = null;
    }
  }
  for (const live of liveSubagents.values()) messages.push(live);
  if (streaming) messages.push(streaming);
  return messages;
}

export function subagentBlockFromPayload(
  payload: Record<string, unknown>,
): Extract<MessageBlock, { kind: "subagent" }> {
  const status = payload.status;
  return {
    kind: "subagent",
    agentId: String(payload.agentId ?? ""),
    name: String(payload.name ?? "subagent"),
    task: String(payload.task ?? ""),
    status: status === "completed" || status === "failed" ? status : "running",
    progress: payload.progress ? String(payload.progress) : undefined,
    result: payload.result ? String(payload.result) : undefined,
  };
}

/** Events the live UI can apply locally. A full snapshot refresh is only needed after these. */
const SNAPSHOT_REFRESH_EVENTS = new Set([
  "run.completed",
  "run.failed",
  "run.cancelled",
  "bot.spawned",
  "thread.cleared",
]);

export function threadEventNeedsSnapshotRefresh(type: string): boolean {
  return SNAPSHOT_REFRESH_EVENTS.has(type);
}

export function redactSecrets(value: string, secrets: string[]): string {
  return secrets.reduce((acc, secret) => {
    if (!secret) return acc;
    return acc.split(secret).join("[redacted]");
  }, value);
}

export function containsSecret(value: unknown, secrets: string[]): boolean {
  const text = JSON.stringify(value);
  return secrets.some((secret) => secret.length > 0 && text.includes(secret));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
