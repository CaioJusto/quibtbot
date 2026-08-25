import { describe, expect, it } from "vitest";
import { memoryLabel, splitMemoryDocs } from "./memory-panel";

const doc = (
  scope: "bot" | "user",
  path: string,
  content: string,
): Parameters<typeof splitMemoryDocs>[0][number] => ({
  id: `mem_${scope}_${path}`,
  scope,
  botId: scope === "bot" ? "bot_1" : null,
  path,
  content,
  revision: 1,
  updatedAt: "2026-08-15T00:00:00.000Z",
});

describe("splitMemoryDocs", () => {
  it("picks MEMORY.md for the bot and USER.md for the account", () => {
    const split = splitMemoryDocs([
      doc("bot", "MEMORY.md", "Prefers Rust"),
      doc("user", "USER.md", "Timezone America/Sao_Paulo"),
      doc("user", "MEMORY.md", "legacy"),
      doc("bot", "notes.md", "ignore"),
    ]);
    expect(split.bot?.content).toContain("Rust");
    expect(split.user?.content).toContain("Sao_Paulo");
    expect(split.user?.content).not.toContain("legacy");
  });

  it("falls back to the old account MEMORY.md when USER.md is missing", () => {
    const split = splitMemoryDocs([doc("user", "MEMORY.md", "Timezone America/Sao_Paulo")]);
    expect(split.user?.content).toContain("Sao_Paulo");
  });

  it("survives a bot that has not written anything yet", () => {
    expect(splitMemoryDocs([])).toEqual({ bot: undefined, user: undefined });
  });
});

describe("memoryLabel", () => {
  it("labels the two scopes in Portuguese", () => {
    expect(memoryLabel("bot")).toBe("MEMORY.md — notas do agente");
    expect(memoryLabel("user")).toBe("USER.md — perfil");
  });
});
