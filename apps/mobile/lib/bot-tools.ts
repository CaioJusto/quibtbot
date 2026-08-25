/**
 * Pure helpers behind the bot settings actions that talk to server RPCs already
 * used on web: `memory.list` / `memory.update` (`apps/web/src/pages/AgentSettings.tsx`),
 * `bots.duplicate` and `export.bot` (`apps/web/src/pages/Shell.tsx`). This file only
 * shapes requests/responses and file naming — the actual RPC calls, navigation and
 * `expo-file-system` / `expo-sharing` side effects live in `apps/mobile/app/settings.tsx`.
 */
import type { MemoryDocument } from "@quibt/contracts";
import {
  MEMORY_CHAR_LIMIT,
  memoryCharCount,
  parseMemoryEntries,
  USER_CHAR_LIMIT,
} from "@quibt/core";
import { DEFAULT_MARK_COLOR } from "@quibt/ui-tokens";
import type { MobileBot } from "./api";

export { MEMORY_CHAR_LIMIT, USER_CHAR_LIMIT };

export type MemoryScope = "bot" | "user";

/** `memory/list` payload for MEMORY.md — the agent's own notes, scoped to this bot. */
export function memoryListBotPayload(botId: string): { botId: string; scope: "bot" } {
  return { botId, scope: "bot" };
}

/** `memory/list` payload for USER.md — one profile per account, not per bot. */
export function memoryListUserPayload(): { scope: "user" } {
  return { scope: "user" };
}

/**
 * Same split as the web's `apps/web/src/lib/memory-panel.ts`: MEMORY.md holds the
 * agent's notes, USER.md the account profile (falling back to a legacy MEMORY.md
 * written under the user scope).
 */
export function splitMobileMemoryDocs(docs: MemoryDocument[]): {
  bot: MemoryDocument | undefined;
  user: MemoryDocument | undefined;
} {
  return {
    bot: docs.find((doc) => doc.scope === "bot" && doc.path === "MEMORY.md"),
    user:
      docs.find((doc) => doc.scope === "user" && doc.path === "USER.md") ??
      docs.find((doc) => doc.scope === "user" && doc.path === "MEMORY.md"),
  };
}

export function memoryCharLimitFor(scope: MemoryScope): number {
  return scope === "user" ? USER_CHAR_LIMIT : MEMORY_CHAR_LIMIT;
}

/** True once the entries a save would write exceed the Hermes budget for that store. */
export function memoryOverLimit(content: string, scope: MemoryScope): boolean {
  return memoryCharCount(parseMemoryEntries(content)) > memoryCharLimitFor(scope);
}

/** `memory/update` payload — this is the "save": there is no separate `memory.save`. */
export function memoryUpdatePayload(
  documentId: string,
  content: string,
): { documentId: string; content: string } {
  return { documentId, content };
}

export type DuplicateBotThreadTarget = {
  pathname: "/thread";
  params: {
    botId: string;
    name: string;
    color: string;
    shape: string;
    demo: "0";
  };
};

/**
 * Where to send the user right after `bots/duplicate` succeeds: the new bot's own
 * thread, not back to the settings screen of the bot that was just copied.
 */
export function duplicateBotNavigationTarget(
  copy: Pick<MobileBot, "id" | "name" | "color" | "shape">,
): DuplicateBotThreadTarget {
  return {
    pathname: "/thread",
    params: {
      botId: copy.id,
      name: copy.name,
      color: copy.color ?? DEFAULT_MARK_COLOR,
      shape: copy.shape ?? "",
      demo: "0",
    },
  };
}

/** Matches the web download name in `apps/web/src/pages/Shell.tsx`. */
export function exportFileName(botName: string): string {
  return `${botName.toLowerCase().replace(/\s+/g, "-")}-export.json`;
}

export type ExportSharePayload = {
  fileName: string;
  contents: string;
};

/**
 * Pure builder for the file that gets written to app cache and handed to the native
 * share sheet. Kept separate from `expo-file-system` / `expo-sharing` so the naming
 * and JSON shape can be unit tested without a device.
 */
export function buildExportSharePayload(botName: string, manifest: unknown): ExportSharePayload {
  return {
    fileName: exportFileName(botName),
    contents: JSON.stringify(manifest, null, 2),
  };
}

/** Demo bots have no server-side memory, copy or export — keep those actions demo-safe. */
export function demoToolUnavailableMessage(action: "memory" | "duplicate" | "export"): string {
  if (action === "memory") return "A memória fica disponível nos seus bots reais.";
  if (action === "duplicate") return "Duplicar fica disponível nos seus bots reais.";
  return "Exportar fica disponível nos seus bots reais.";
}
