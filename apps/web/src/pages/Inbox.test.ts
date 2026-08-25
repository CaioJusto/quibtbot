import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "Inbox.tsx"),
  "utf8",
);

describe("inbox presence", () => {
  it("shows the presence dot on every list row: green working, blue waiting for you", () => {
    expect(src).toContain("inboxPresence({ status: row.bot.status, unread: row.bot.unread })");
  });

  it("copies the landing product-demo inbox chrome", () => {
    expect(src).toContain("qb-dash__search");
    expect(src).toContain("qb-dash__bot-row");
    expect(src).toContain("qb-dash__user");
    expect(src).toContain('aria-label="Conta"');
    expect(src).not.toContain("featured");
  });

  it("has pin, unread, duplicate, clear and hide actions — chief is not a toggle", () => {
    expect(src).toContain("onContextMenu");
    expect(src).toContain("Fixar");
    expect(src).toContain("Duplicar");
    // Chefia é o que a pessoa diz ao bot na conversa ("coordene os outros"), não um
    // interruptor de menu; o rótulo "Tornar chefe" saiu de propósito.
    expect(src).not.toContain("Tornar chefe");
    expect(src).toContain("Limpar conversa");
    expect(src).toContain("Ocultar da lista");
    expect(src).toContain("Mostrar");
    expect(src).toContain("row.bot.unread");
  });

  it("keeps a plugins shortcut and copy-id actions in the sidebar chrome", () => {
    expect(src).toContain("onPlugins");
    expect(src).toContain("Copiar ID da conversa");
    expect(src).toContain("qb-dash__footer");
    expect(src).toContain("is-chief");
  });

  it("filters rows with the search query and can show an empty match", () => {
    expect(src).toContain("matchesInboxQuery");
    expect(src).toContain("Nada combina com");
  });
});
