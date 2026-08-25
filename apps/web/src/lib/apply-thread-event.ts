import type {
  ComputerStatus,
  GroupThreadSnapshot,
  ProductEvent,
  ThreadMessage,
  ThreadSnapshot,
} from "@quibt/contracts";
import { subagentBlockFromPayload } from "@quibt/core";
import type { Dispatch, SetStateAction } from "react";

export function applyThreadEvent(
  event: ProductEvent,
  setSnapshot: Dispatch<SetStateAction<ThreadSnapshot | null>>,
  setComputer: Dispatch<SetStateAction<ComputerStatus | null>>,
) {
  if (event.type === "thread.cleared") {
    setSnapshot((prev) => {
      if (!prev) return prev;
      return { ...prev, cursor: event.seq, messages: [], run: null };
    });
    return;
  }
  if (event.type === "thread.progress") {
    const text = String(event.payload.text ?? "");
    setSnapshot((prev) => {
      if (!prev) return prev;
      const streaming: ThreadMessage = {
        id: `progress:${event.runId ?? event.id}`,
        threadId: event.threadId,
        seq: event.seq,
        role: "bot",
        blocks: [{ kind: "progress", text }],
        runId: event.runId,
        createdAt: event.createdAt,
      };
      const without = prev.messages.filter((message) => !message.id.startsWith("progress:"));
      return { ...prev, cursor: event.seq, messages: [...without, streaming] };
    });
    return;
  }
  if (event.type === "thread.subagent") {
    const block = subagentBlockFromPayload(event.payload);
    const next: ThreadMessage = {
      id: `subagent:${block.agentId}`,
      threadId: event.threadId,
      seq: event.seq,
      role: "bot",
      blocks: [block],
      runId: event.runId,
      createdAt: event.createdAt,
    };
    setSnapshot((prev) => {
      if (!prev) return prev;
      const without = prev.messages.filter(
        (message) => message.id !== next.id && !message.id.startsWith("progress:"),
      );
      const progress = prev.messages.filter((message) => message.id.startsWith("progress:"));
      return { ...prev, cursor: event.seq, messages: [...without, next, ...progress] };
    });
    return;
  }
  if (event.type === "thread.message.created") {
    const role = (event.payload.role as ThreadMessage["role"]) ?? "bot";
    const blocks = (event.payload.blocks as ThreadMessage["blocks"]) ?? [];
    const next: ThreadMessage = {
      id: String(event.payload.messageId ?? event.id),
      threadId: event.threadId,
      seq: event.seq,
      role,
      blocks,
      runId: event.runId,
      fromBotId: typeof event.payload.fromBotId === "string" ? event.payload.fromBotId : undefined,
      authorBotId:
        typeof event.payload.authorBotId === "string" ? event.payload.authorBotId : undefined,
      replyToId: typeof event.payload.replyToId === "string" ? event.payload.replyToId : undefined,
      createdAt: event.createdAt,
    };
    setSnapshot((prev) => {
      if (!prev) return prev;
      const without = prev.messages.filter(
        (message) =>
          message.id !== next.id &&
          !message.id.startsWith("progress:") &&
          !replacedSubagent(message, blocks),
      );
      return { ...prev, cursor: event.seq, messages: [...without, next] };
    });
  }
  if (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled"
  ) {
    setSnapshot((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        cursor: event.seq,
        run: null,
        messages: prev.messages.filter((message) => !message.id.startsWith("progress:")),
      };
    });
    return;
  }
  if (event.type === "computer.status" || event.type === "computer.takeover.granted") {
    const status = String(event.payload.status ?? "");
    setComputer((prev) =>
      prev
        ? {
            ...prev,
            controlHolder: event.type === "computer.takeover.granted" ? "user" : prev.controlHolder,
            state:
              event.type === "computer.status" &&
              ["stopped", "booting", "running", "suspended", "error"].includes(status)
                ? (status as ComputerStatus["state"])
                : prev.state,
            screenAvailable: status === "running" || status === "booting" || prev.screenAvailable,
          }
        : prev,
    );
  }
}

export function applyGroupThreadEvent(
  event: ProductEvent,
  setSnapshot: Dispatch<SetStateAction<GroupThreadSnapshot | null>>,
) {
  if (event.type === "thread.progress") {
    const text = String(event.payload.text ?? "");
    const id = `progress:${event.runId ?? event.id}`;
    const streaming: ThreadMessage = {
      id,
      threadId: event.threadId,
      seq: event.seq,
      role: "bot",
      blocks: [{ kind: "progress", text }],
      runId: event.runId,
      authorBotId:
        typeof event.payload.authorBotId === "string" ? event.payload.authorBotId : undefined,
      createdAt: event.createdAt,
    };
    setSnapshot((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        cursor: event.seq,
        messages: [...prev.messages.filter((message) => message.id !== id), streaming],
      };
    });
    return;
  }
  if (event.type === "thread.message.created") {
    applyThreadEvent(
      event,
      setSnapshot as Dispatch<SetStateAction<ThreadSnapshot | null>>,
      () => undefined,
    );
    return;
  }
  if (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled"
  ) {
    const progressId = event.runId ? `progress:${event.runId}` : null;
    setSnapshot((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        cursor: event.seq,
        runs: event.runId ? prev.runs.filter((run) => run.id !== event.runId) : prev.runs,
        messages: prev.messages.filter((message) =>
          progressId ? message.id !== progressId : !message.id.startsWith("progress:"),
        ),
      };
    });
  }
}

function replacedSubagent(message: ThreadMessage, blocks: ThreadMessage["blocks"]) {
  const agentIds = new Set(
    blocks.filter((block) => block.kind === "subagent").map((block) => block.agentId),
  );
  if (agentIds.size === 0) return false;
  return message.blocks.some((block) => block.kind === "subagent" && agentIds.has(block.agentId));
}
