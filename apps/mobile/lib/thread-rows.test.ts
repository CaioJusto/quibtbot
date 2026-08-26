import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { MobileMessage } from "./api";
import { approvalKind, buildThreadRows, isNearBottom, reconcileThreadRows } from "./thread-rows.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

function message(patch: Partial<MobileMessage> & { id: string }): MobileMessage {
  return { role: "bot", blocks: [{ kind: "text", text: "oi" }], ...patch };
}

const bots = [{ id: "bot_ada", name: "Ada", preview: "", title: "", color: "#E65707" }];
const members = [
  { id: "bot_ada", name: "Ada", color: "#E65707", shape: "cube" },
  { id: "bot_pip", name: "Pip", color: "#30D158" },
];

describe("buildThreadRows", () => {
  it("keys every row by the message id so a reconnect does not remount the list", () => {
    const rows = buildThreadRows({
      messages: [message({ id: "m1" }), message({ id: "progress:run_1" })],
      botId: "bot_self",
      bots,
      members: [],
      isGroup: false,
    });
    expect(rows.map((row) => row.key)).toEqual(["m1", "progress:run_1"]);
  });

  it("bundles consecutive bubbles from the same speaker and stamps only the day change", () => {
    const rows = buildThreadRows({
      messages: [
        message({ id: "m1", role: "user", createdAt: "2026-08-14T10:00:00.000Z" }),
        message({ id: "m2", role: "user", createdAt: "2026-08-14T10:00:30.000Z" }),
        message({ id: "m3", role: "bot", createdAt: "2026-08-14T10:01:00.000Z" }),
      ],
      botId: "bot_self",
      bots,
      members: [],
      isGroup: false,
      now: new Date("2026-08-14T12:00:00.000Z"),
    });
    expect(rows.map((row) => row.bundled)).toEqual([false, true, false]);
    expect(rows[0]?.stamp).toBeTruthy();
    expect(rows[1]?.stamp).toBeNull();
    expect(rows.map((row) => row.mine)).toEqual([true, true, false]);
  });

  it("shows a group member's mark only on the last bubble of their bundle", () => {
    const rows = buildThreadRows({
      messages: [
        message({ id: "m1", authorBotId: "bot_ada" }),
        message({ id: "m2", authorBotId: "bot_ada" }),
        message({ id: "m3", authorBotId: "bot_pip" }),
      ],
      bots,
      members,
      isGroup: true,
    });
    expect(rows.map((row) => row.showAuthorMark)).toEqual([false, true, true]);
    expect(rows[0]?.authorName).toBe("Ada");
    expect(rows[2]?.authorColor).toBe("#30D158");
    // "Mensagem de X" is a 1:1 thread thing; a group labels the author above the bubble.
    expect(rows.every((row) => row.from === null)).toBe(true);
  });

  it("labels a peer bot writing into a 1:1 thread", () => {
    const rows = buildThreadRows({
      messages: [message({ id: "m1", fromBotId: "bot_ada" })],
      botId: "bot_self",
      bots,
      members: [],
      isGroup: false,
    });
    expect(rows[0]?.from).toBe("Mensagem de Ada");
  });

  it("answers an ask with the bot that asked, and drops the buttons once answered", () => {
    const asked = message({
      id: "m1",
      runId: "run_1",
      authorBotId: "bot_ada",
      blocks: [{ kind: "ask", text: "posso?", tool: "shell" }],
    });
    const rows = buildThreadRows({
      messages: [asked, { ...asked, id: "m2", blocks: [{ kind: "ask", answered: "allow" }] }],
      botId: "bot_self",
      bots,
      members: [],
      isGroup: false,
    });
    // Card antigo, sem `actions`: o Sempre valia quando havia allowKey.
    expect(rows[0]?.approval).toBe("tool-once");
    expect(rows[0]?.answerBotId).toBe("bot_ada");
    expect(rows[1]?.approval).toBeNull();
    expect(approvalKind(message({ id: "m3", runId: "r", blocks: [{ kind: "ask" }] }))).toBe(
      "message",
    );
    expect(
      approvalKind(
        message({
          id: "m4",
          runId: "r",
          blocks: [{ kind: "ask", tool: "shell", allowKey: "shell:git" }],
        }),
      ),
    ).toBe("tool");
    // O servidor só oferece "Sempre" quando vai honrar; um card destrutivo vem sem ele.
    expect(
      approvalKind(
        message({
          id: "m5",
          runId: "r",
          blocks: [
            {
              kind: "ask",
              tool: "shell",
              allowKey: "shell:rm",
              actions: [
                { id: "allow", label: "Permitir" },
                { id: "deny", label: "Recusar" },
              ],
            },
          ],
        }),
      ),
    ).toBe("tool-once");
  });

  it("reuses unchanged row objects when streaming progress changes", () => {
    const stable = message({ id: "m1" });
    const base = { botId: "bot_self", bots, members: [], isGroup: false };
    const first = reconcileThreadRows([], {
      ...base,
      messages: [
        stable,
        message({ id: "progress:run", blocks: [{ kind: "progress", text: "one" }] }),
      ],
    });
    const second = reconcileThreadRows(first, {
      ...base,
      messages: [
        stable,
        message({ id: "progress:run", blocks: [{ kind: "progress", text: "two" }] }),
      ],
    });
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
  });

  it("rebuilds a row when its next-neighbor bundle state changes", () => {
    const stable = message({ id: "m1", authorBotId: "bot_ada" });
    const base = { bots, members, isGroup: true };
    const first = reconcileThreadRows([], { ...base, messages: [stable] });
    const second = reconcileThreadRows(first, {
      ...base,
      messages: [stable, message({ id: "m2", authorBotId: "bot_ada" })],
    });
    expect(second[0]).not.toBe(first[0]);
  });
});

describe("auto-scroll", () => {
  it("follows the thread only while the user sits at the bottom", () => {
    const atBottom = {
      contentOffset: { y: 900 },
      contentSize: { height: 1_400 },
      layoutMeasurement: { height: 500 },
    };
    expect(isNearBottom(atBottom)).toBe(true);
    expect(
      isNearBottom({ ...atBottom, contentOffset: { y: 300 } }),
      "scrolled up to read: the list must not jump",
    ).toBe(false);
  });
});

describe("thread screen list", () => {
  const screen = readFileSync(path.join(dir, "../app/thread.tsx"), "utf8");

  it("virtualizes the thread instead of mounting every bubble", () => {
    expect(screen).toContain("FlatList");
    expect(screen).toContain("keyExtractor");
    expect(screen).toContain("reconcileThreadRows");
    // The message list is the FlatList now; no ScrollView wrapping the bubbles.
    expect(screen).not.toContain("<ScrollView");
  });

  it("keeps the auto-scroll pinned to the bottom rule", () => {
    expect(screen).toContain("isNearBottom");
    expect(screen).toContain("pinnedToBottom");
    expect(screen).toContain("scrollToEnd");
    expect(screen).toContain("requestAnimationFrame");
    expect(screen).toContain("cancelAnimationFrame");
  });

  it("anchors a short conversation immediately above the composer", () => {
    expect(screen).toContain("flexGrow: 1");
    expect(screen).toContain('justifyContent: "flex-end"');
    expect(screen).not.toContain("ListFooterComponent");
    expect(screen).not.toContain("tailSpaceFor");
  });

  it("guarda um lugar fixo para o chip do fio, por cima da conversa", () => {
    // A decisão de quando pollar e o que o chip diz é testada de verdade em
    // live-link.test.ts; aqui fica só o lugar dele na tela, que é o que esta suíte sabe ver.
    expect(screen).toContain("connectionChip");
    expect(screen).toContain('accessibilityLiveRegion="polite"');
    expect(screen).toContain("styles.linkChipRow");
    expect(screen).toContain("insets.top + 74");
  });

  it("sends the user to the login on the first 401 instead of reconnecting", () => {
    expect(screen).toContain("isSessionExpiredError");
    expect(screen).toContain('router.replace("/welcome")');
    expect(screen).toContain("live?.stop()");
  });

  it("shows the same run stop action as desktop and clears progress after it succeeds", () => {
    expect(screen).toContain("async function stopWorkingRuns()");
    expect(screen).toContain('rpc("threads/stop", { botId: id })');
    expect(screen).toContain('"Parar agente"');
    expect(screen).toContain("run: isGroup ? current.run : null");
    expect(screen).toContain('!message.id.startsWith("progress:")');
  });
});
