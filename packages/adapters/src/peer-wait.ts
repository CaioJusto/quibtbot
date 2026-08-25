import type { WakeupDriver } from "@quibt/adapter-kit";
import type { MessageBlock } from "@quibt/contracts";
import type { PrismaClient } from "@quibt/db";
import { ApprovalPause } from "./approval-wait.js";

/** How long the asker waits for a teammate before giving up on the answer. */
export const PEER_WAIT_TIMEOUT_MS = 4 * 60_000;

/**
 * `ask_bot` used to busy-wait inside the turn, holding one of the four worker slots for up
 * to four minutes. The wait is a checkpoint instead: the turn ends, the slot goes back to
 * the pool, and the answer arrives as a fresh `run.continue` when the teammate finishes.
 */
export const PEER_WAIT_TEXT = "Waiting for the teammate's answer.";

export class PeerPause extends ApprovalPause {
  // The run waits for another bot, not for the user: saying "waiting for your approval" here
  // would leave a false claim in the history the model reads when it resumes.
  override readonly waitingText = PEER_WAIT_TEXT;

  constructor() {
    super();
    this.name = "PeerPause";
  }
}

export interface PendingPeerAsk {
  peerRunId: string;
  botId: string;
  botName: string;
  question: string;
  executionId: string;
  deadlineAt: string;
}

/** The `run.continue` wake that bounds the wait when the teammate never finishes. */
export function peerWaitJobKey(runId: string): string {
  return `peer-wait:${runId}`;
}

/** What `wakeRunsWaitingForPeer` looks for inside the stored checkpoint. */
export function peerWaitMarker(peerRunId: string): string {
  return `"peerRunId":"${peerRunId}"`;
}

export function peerCheckpoint(pending: PendingPeerAsk): string {
  // peerRunId first so `peerWaitMarker` matches the serialized checkpoint.
  return JSON.stringify({
    pendingPeer: {
      peerRunId: pending.peerRunId,
      botId: pending.botId,
      botName: pending.botName,
      question: pending.question,
      executionId: pending.executionId,
      deadlineAt: pending.deadlineAt,
    },
  });
}

export function parsePeerCheckpoint(raw: string | null | undefined): PendingPeerAsk | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { pendingPeer?: Partial<PendingPeerAsk> };
    const pending = parsed.pendingPeer;
    if (!pending?.peerRunId || !pending.botId) return undefined;
    return {
      peerRunId: pending.peerRunId,
      botId: pending.botId,
      botName: pending.botName ?? "teammate",
      question: pending.question ?? "",
      executionId: pending.executionId ?? pending.peerRunId,
      deadlineAt: pending.deadlineAt ?? new Date(0).toISOString(),
    };
  } catch {
    return undefined;
  }
}

export type PeerAnswer =
  | { state: "pending" }
  | { state: "answered"; text: string; status: string }
  | { state: "waiting"; status: string }
  | { state: "timeout" };

/** Reads the teammate run once and decides whether the asker can resume. */
export async function resolvePeerAnswer(
  prisma: PrismaClient,
  pending: PendingPeerAsk,
  now: Date = new Date(),
): Promise<PeerAnswer> {
  const peerRun = await prisma.run.findUnique({ where: { id: pending.peerRunId } });
  if (peerRun && ["waiting_input", "waiting_takeover"].includes(peerRun.status)) {
    return { state: "waiting", status: peerRun.status };
  }
  if (!peerRun || ["completed", "failed", "cancelled"].includes(peerRun.status)) {
    const last = await prisma.message.findFirst({
      where: { runId: pending.peerRunId, role: "bot" },
      orderBy: { seq: "desc" },
    });
    const blocks = (last?.blocks ?? []) as MessageBlock[];
    const text =
      blocks.find(
        (block): block is Extract<MessageBlock, { text: string }> =>
          "text" in block && Boolean(block.text),
      )?.text ?? "";
    return { state: "answered", text, status: peerRun?.status ?? "missing" };
  }
  if (now.getTime() >= Date.parse(pending.deadlineAt)) return { state: "timeout" };
  return { state: "pending" };
}

/** The system line the asker sees when its turn restarts with the teammate's answer. */
export function peerAnswerNote(pending: PendingPeerAsk, answer: PeerAnswer): string {
  const prefix = `You asked ${pending.botName}: ${pending.question}`.trim();
  const tail = "Do not ask the same teammate again; continue the work with this answer.";
  if (answer.state === "answered") {
    return `${prefix}\n${pending.botName} answered (${answer.status}): ${answer.text || "(sem resposta)"}\n${tail}`;
  }
  if (answer.state === "waiting") {
    return `${prefix}\n${pending.botName} is blocked waiting for the user (${answer.status}).\n${tail}`;
  }
  return `${prefix}\n${pending.botName} did not answer in time.\n${tail}`;
}

/** Wakes every run parked on this teammate run as soon as it reaches a terminal state. */
export async function wakeRunsWaitingForPeer(
  deps: { prisma: PrismaClient; wakeup?: WakeupDriver },
  peerRunId: string,
): Promise<string[]> {
  if (!deps.wakeup) return [];
  const waiting = await deps.prisma.run.findMany({
    where: { status: "waiting_input", checkpoint: { contains: peerWaitMarker(peerRunId) } },
    select: { id: true },
  });
  for (const row of waiting) {
    await deps.wakeup
      .enqueue({ name: "run.continue", payload: { runId: row.id } })
      .catch((error) => console.error("run.continue", error));
  }
  return waiting.map((row) => row.id);
}
