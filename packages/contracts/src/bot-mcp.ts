import * as z from "zod";
import { Id } from "./ids.js";

export const BOT_MCP_LIMITS = {
  serversPerBot: 10,
  nameChars: 64,
  commandChars: 1_024,
  args: 64,
  argChars: 2_048,
  urlChars: 2_048,
  envKeys: 64,
  envKeyChars: 128,
  envValueChars: 4_096,
  envBytes: 16 * 1_024,
} as const;

export const BotMcpTransportSchema = z.enum(["stdio", "http"]);

export const BotMcpServerSchema = z.object({
  id: Id,
  botId: Id,
  name: z.string(),
  transport: BotMcpTransportSchema,
  command: z.string().nullable(),
  args: z.array(z.string()),
  url: z.string().nullable(),
  enabled: z.boolean(),
  disabledReason: z.string().nullable(),
  createdAt: z.string(),
});
export type BotMcpServer = z.infer<typeof BotMcpServerSchema>;

const BotMcpEnvSchema = z
  .record(
    z.string().min(1).max(BOT_MCP_LIMITS.envKeyChars),
    z.string().max(BOT_MCP_LIMITS.envValueChars),
  )
  .superRefine((env, context) => {
    if (Object.keys(env).length > BOT_MCP_LIMITS.envKeys) {
      context.addIssue({ code: "custom", message: "too many MCP environment variables" });
    }
    if (new TextEncoder().encode(JSON.stringify(env)).byteLength > BOT_MCP_LIMITS.envBytes) {
      context.addIssue({ code: "custom", message: "MCP environment is too large" });
    }
  });

export const AddBotMcpServerInput = z
  .object({
    botId: Id,
    name: z.string().trim().min(1).max(BOT_MCP_LIMITS.nameChars),
    command: z.string().max(BOT_MCP_LIMITS.commandChars).optional(),
    args: z.array(z.string().max(BOT_MCP_LIMITS.argChars)).max(BOT_MCP_LIMITS.args).default([]),
    url: z.string().max(BOT_MCP_LIMITS.urlChars).optional(),
    env: BotMcpEnvSchema.optional(),
  })
  .refine((value) => Boolean(value.command) !== Boolean(value.url), {
    message: "provide either an MCP command or HTTPS URL",
  });
export type AddBotMcpServerInput = z.infer<typeof AddBotMcpServerInput>;
