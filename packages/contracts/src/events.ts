import * as z from "zod";
import { Id } from "./ids.js";

export const ProductEventType = z.enum([
  "thread.message.created",
  "thread.cleared",
  "thread.progress",
  "thread.artifact",
  "thread.ask",
  "thread.choice",
  "thread.meta",
  "thread.computer",
  "thread.subagent",
  "run.started",
  "run.checkpointed",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "computer.status",
  "computer.takeover.requested",
  "computer.takeover.granted",
  "computer.takeover.released",
  "memory.revised",
  "routine.created",
  "routine.updated",
  "routine.fired",
  "effect.recorded",
  "effect.reconciled",
  "usage.recorded",
  "bot.spawned",
  "bot.deleted",
]);
export type ProductEventType = z.infer<typeof ProductEventType>;

export const MessageRole = z.enum(["user", "bot", "system"]);

export const MessageBlock = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({
    kind: z.literal("card"),
    lines: z.array(z.object({ k: z.string(), v: z.string() })),
  }),
  z.object({
    kind: z.literal("ask"),
    text: z.string(),
    detail: z.string().optional(),
    actions: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
    tool: z.string().optional(),
    allowKey: z.string().optional(),
    requestId: z.string().optional(),
    answered: z.string().optional(),
    held: z.string().optional(),
  }),
  z.object({
    kind: z.literal("choice"),
    question: z.string(),
    subtitle: z.string().optional(),
    options: z.array(z.object({ id: z.string(), letter: z.string(), label: z.string() })),
  }),
  z.object({
    kind: z.literal("connect"),
    name: z.string(),
    initial: z.string(),
    color: z.string(),
    status: z.enum(["pending", "connected"]),
  }),
  z.object({
    kind: z.literal("computer"),
    state: z.string(),
    text: z.string(),
  }),
  /**
   * Um arquivo dentro do recado: o print que o bot tirou, o PDF que ele gerou, a
   * planilha que você mandou. Os bytes ficam no artefato; aqui vai só o suficiente
   * para desenhar a linha sem ir buscá-los.
   */
  z.object({
    kind: z.literal("file"),
    artifactId: Id,
    name: z.string(),
    mimeType: z.string(),
    size: z.number().int().nonnegative(),
    /** Imagem: dá para mostrar inteira no fio, em vez de um cartão para baixar. */
    image: z.boolean().optional(),
    caption: z.string().optional(),
  }),
  z.object({ kind: z.literal("meta"), text: z.string() }),
  z.object({ kind: z.literal("progress"), text: z.string() }),
  z.object({
    kind: z.literal("subagent"),
    agentId: z.string(),
    name: z.string(),
    task: z.string(),
    status: z.enum(["running", "completed", "failed"]),
    progress: z.string().optional(),
    result: z.string().optional(),
  }),
  z.object({
    kind: z.literal("child_bot"),
    botId: z.string(),
    name: z.string(),
    title: z.string().optional(),
    status: z.enum(["created", "deleted"]),
  }),
]);
export type MessageBlock = z.infer<typeof MessageBlock>;

export const ProductEventSchema = z.object({
  id: Id,
  workspaceId: Id,
  threadId: Id,
  botId: Id.optional(),
  seq: z.number().int().nonnegative(),
  type: ProductEventType,
  runId: Id.optional(),
  createdAt: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type ProductEvent = z.infer<typeof ProductEventSchema>;

export const ThreadMessageSchema = z.object({
  id: Id,
  threadId: Id,
  seq: z.number().int().nonnegative(),
  role: MessageRole,
  blocks: z.array(MessageBlock),
  runId: Id.optional(),
  fromBotId: Id.optional(),
  authorBotId: Id.optional(),
  conversationId: Id.optional(),
  parentId: Id.optional(),
  /** Recado citado por este. `parentId` é a árvore de edições; isto é a resposta. */
  replyToId: Id.optional(),
  /** Emoji → quem reagiu. O bot lê isso como sinal do que agradou ou não. */
  reactions: z.record(z.string().min(1).max(24), z.array(Id)).optional(),
  createdAt: z.string(),
});
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;
