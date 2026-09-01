import * as z from "zod";
import { Id } from "./ids.js";

export const BOT_OPENAPI_LIMITS = {
  sourcesPerBot: 10,
  nameChars: 64,
  urlChars: 2_048,
  specBytes: 512 * 1_024,
  responseBytes: 256 * 1_024,
  operationsPerSource: 32,
  operationsTotal: 128,
  refDepth: 8,
  redirects: 3,
  fetchTimeoutMs: 10_000,
} as const;

export const BotOpenApiSourceSchema = z.object({
  id: Id,
  botId: Id,
  name: z.string(),
  url: z.string(),
  enabled: z.boolean(),
  disabledReason: z.string().nullable(),
  createdAt: z.string(),
});
export type BotOpenApiSource = z.infer<typeof BotOpenApiSourceSchema>;

export const AddBotOpenApiSourceInput = z.object({
  botId: Id,
  name: z.string().trim().min(1).max(BOT_OPENAPI_LIMITS.nameChars),
  url: z.string().trim().max(BOT_OPENAPI_LIMITS.urlChars),
});
export type AddBotOpenApiSourceInput = z.infer<typeof AddBotOpenApiSourceInput>;
