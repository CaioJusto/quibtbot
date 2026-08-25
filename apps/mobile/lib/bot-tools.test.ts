import { describe, expect, it } from "vitest";
import {
  buildExportSharePayload,
  demoToolUnavailableMessage,
  duplicateBotNavigationTarget,
  exportFileName,
  MEMORY_CHAR_LIMIT,
  memoryCharLimitFor,
  memoryListBotPayload,
  memoryListUserPayload,
  memoryOverLimit,
  memoryUpdatePayload,
  splitMobileMemoryDocs,
  USER_CHAR_LIMIT,
} from "./bot-tools.js";

const botDoc = {
  id: "mem_bot",
  scope: "bot" as const,
  botId: "bot_ada",
  path: "MEMORY.md",
  content: "notes",
  revision: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const userDoc = {
  id: "mem_user",
  scope: "user" as const,
  botId: null,
  path: "USER.md",
  content: "profile",
  revision: 2,
  updatedAt: "2026-01-02T00:00:00.000Z",
};

describe("memory list payloads", () => {
  it("scopes MEMORY.md to the bot", () => {
    expect(memoryListBotPayload("bot_ada")).toEqual({ botId: "bot_ada", scope: "bot" });
  });

  it("scopes USER.md to the account, with no botId", () => {
    expect(memoryListUserPayload()).toEqual({ scope: "user" });
  });
});

describe("memory/update payload (the only save RPC)", () => {
  it("sends documentId and content, nothing else", () => {
    expect(memoryUpdatePayload("mem_bot", "novo texto")).toEqual({
      documentId: "mem_bot",
      content: "novo texto",
    });
  });
});

describe("splitMobileMemoryDocs", () => {
  it("splits MEMORY.md (bot) and USER.md (user)", () => {
    expect(splitMobileMemoryDocs([botDoc, userDoc])).toEqual({ bot: botDoc, user: userDoc });
  });

  it("falls back to a legacy user-scoped MEMORY.md when there is no USER.md", () => {
    const legacy = { ...userDoc, path: "MEMORY.md" };
    expect(splitMobileMemoryDocs([botDoc, legacy]).user).toEqual(legacy);
  });

  it("returns undefined docs when nothing matches", () => {
    expect(splitMobileMemoryDocs([])).toEqual({ bot: undefined, user: undefined });
  });
});

describe("memory limits", () => {
  it("re-exports the Hermes char limits from @quibt/core", () => {
    expect(MEMORY_CHAR_LIMIT).toBe(2200);
    expect(USER_CHAR_LIMIT).toBe(1375);
  });

  it("picks the limit by scope", () => {
    expect(memoryCharLimitFor("bot")).toBe(MEMORY_CHAR_LIMIT);
    expect(memoryCharLimitFor("user")).toBe(USER_CHAR_LIMIT);
  });

  it("flags content over the bot memory limit", () => {
    expect(memoryOverLimit("short", "bot")).toBe(false);
    expect(memoryOverLimit("x".repeat(MEMORY_CHAR_LIMIT + 1), "bot")).toBe(true);
  });

  it("flags content over the user memory limit", () => {
    expect(memoryOverLimit("x".repeat(USER_CHAR_LIMIT + 1), "user")).toBe(true);
  });
});

describe("duplicateBotNavigationTarget", () => {
  it("points at the new bot's own thread, not the old settings screen", () => {
    expect(
      duplicateBotNavigationTarget({
        id: "bot_copy",
        name: "Maia cópia",
        color: "blue",
        shape: "nova",
      }),
    ).toEqual({
      pathname: "/thread",
      params: {
        botId: "bot_copy",
        name: "Maia cópia",
        color: "blue",
        shape: "nova",
        demo: "0",
      },
    });
  });

  it("falls back to the default mark color and empty shape when missing", () => {
    const target = duplicateBotNavigationTarget({ id: "bot_copy", name: "Cópia" });
    expect(target.params.shape).toBe("");
    expect(typeof target.params.color).toBe("string");
    expect(target.params.color.length).toBeGreaterThan(0);
  });
});

describe("export file naming", () => {
  it("lowercases and dashes the bot name, matching the web export", () => {
    expect(exportFileName("Maia Assistente")).toBe("maia-assistente-export.json");
  });

  it("collapses multiple spaces", () => {
    expect(exportFileName("Atlas   Pesquisa")).toBe("atlas-pesquisa-export.json");
  });
});

describe("buildExportSharePayload", () => {
  it("pairs the export filename with the pretty-printed manifest", () => {
    const manifest = { version: 1, bot: { name: "Maia" } };
    const payload = buildExportSharePayload("Maia", manifest);
    expect(payload.fileName).toBe("maia-export.json");
    expect(payload.contents).toBe(JSON.stringify(manifest, null, 2));
    expect(JSON.parse(payload.contents)).toEqual(manifest);
  });
});

describe("demoToolUnavailableMessage", () => {
  it("gives a clear demo-safe message per action", () => {
    expect(demoToolUnavailableMessage("memory")).toMatch(/mem/i);
    expect(demoToolUnavailableMessage("duplicate")).toMatch(/duplicar/i);
    expect(demoToolUnavailableMessage("export")).toMatch(/exportar/i);
  });
});
