import { describe, expect, it } from "vitest";
import { buildSendWithAttachmentsPayload } from "./attachments.js";
import {
  applyOptimisticReaction,
  buildEditPayload,
  buildOptimisticUserMessage,
  buildReactPayload,
  buildSwitchBranchPayload,
  bundledWithPrevious,
  chatTimeLabel,
  isWorkingPlaceholder,
  LOCAL_REACTOR_ID,
  messageActions,
  peerLine,
  quotedTextFor,
  rollbackMessages,
  shouldShowTimeStamp,
  versionsByParent,
  versionsOf,
} from "./chat.js";

describe("isWorkingPlaceholder", () => {
  it("recognizes only the initial runtime waiting marker", () => {
    expect(isWorkingPlaceholder("Trabalhando…")).toBe(true);
    expect(isWorkingPlaceholder(" working... ")).toBe(true);
    expect(isWorkingPlaceholder("Trabalhando na pesquisa")).toBe(false);
  });
});

const messages = [
  {
    id: "msg_1",
    role: "user" as const,
    parentId: null,
    replyToId: undefined,
    blocks: [{ kind: "text", text: "Primeira versão" }],
    createdAt: "2026-08-13T10:00:00.000Z",
  },
  {
    id: "msg_2",
    role: "bot" as const,
    parentId: "msg_1",
    blocks: [{ kind: "text", text: "Resposta do bot" }],
    createdAt: "2026-08-13T10:01:00.000Z",
  },
  {
    id: "msg_3",
    role: "user" as const,
    parentId: "msg_2",
    blocks: [{ kind: "text", text: "Segunda versão" }],
    createdAt: "2026-08-13T10:02:00.000Z",
  },
  {
    id: "msg_4",
    role: "user" as const,
    parentId: "msg_2",
    blocks: [{ kind: "text", text: "Terceira versão" }],
    createdAt: "2026-08-13T10:03:00.000Z",
  },
];

describe("quotedTextFor", () => {
  it("returns a trimmed citation snippet", () => {
    expect(quotedTextFor(messages, "msg_2")).toBe("Resposta do bot");
  });

  it("truncates long citations", () => {
    const long = "x".repeat(200);
    expect(
      quotedTextFor([{ id: "m", role: "user", blocks: [{ kind: "text", text: long }] }], "m")
        ?.length,
    ).toBeLessThanOrEqual(121);
  });
});

describe("RPC payloads", () => {
  it("builds reaction payloads", () => {
    expect(buildReactPayload({ botId: "bot_ada", messageId: "msg_2", emoji: "👍" })).toEqual({
      botId: "bot_ada",
      messageId: "msg_2",
      emoji: "👍",
    });
  });

  it("builds reply/citation send payloads via attachments helper", () => {
    expect(
      buildSendWithAttachmentsPayload({
        botId: "bot_ada",
        text: "concordo",
        replyToId: "msg_2",
      }),
    ).toEqual({
      botId: "bot_ada",
      text: "concordo",
      clientNonce: undefined,
      attachments: undefined,
      replyToId: "msg_2",
      mentionBotIds: undefined,
    });
  });

  it("builds edit payloads", () => {
    expect(buildEditPayload({ botId: "bot_ada", messageId: "msg_1", text: "Corrigido" })).toEqual({
      botId: "bot_ada",
      messageId: "msg_1",
      text: "Corrigido",
    });
  });

  it("builds branch switch payloads", () => {
    expect(buildSwitchBranchPayload({ botId: "bot_ada", messageId: "msg_3" })).toEqual({
      botId: "bot_ada",
      messageId: "msg_3",
    });
  });
});

describe("messageActions", () => {
  it("offers reply and react for bot messages in a direct thread", () => {
    const actions = messageActions({
      message: messages[1]!,
      isGroup: false,
      working: false,
    }).map((action) => action.kind);
    expect(actions).toContain("reply");
    expect(actions).toContain("react");
    expect(actions).not.toContain("edit");
  });

  it("offers edit and branch navigation for editable user messages", () => {
    const index = versionsByParent(messages);
    const versions = versionsOf(index, messages[3]!);
    const actions = messageActions({
      message: messages[3]!,
      isGroup: false,
      working: false,
      versionIndex: 1,
      versionCount: versions.length,
    }).map((action) => action.kind);
    expect(actions).toContain("edit");
    expect(actions).toContain("branch-prev");
    expect(actions).not.toContain("branch-next");
  });

  it("hides edit while the bot is working", () => {
    const actions = messageActions({
      message: messages[0]!,
      isGroup: false,
      working: true,
    }).map((action) => action.kind);
    expect(actions).not.toContain("edit");
  });

  it("offers only copy for group threads", () => {
    const actions = messageActions({
      message: messages[1]!,
      isGroup: true,
      working: false,
      versionIndex: 1,
      versionCount: 3,
    }).map((action) => action.kind);
    expect(actions).toEqual(["copy"]);
    expect(actions).not.toContain("reply");
    expect(actions).not.toContain("react");
    expect(actions).not.toContain("edit");
    expect(actions).not.toContain("branch-prev");
    expect(actions).not.toContain("branch-next");
  });
});

describe("optimistic reaction rollback", () => {
  it("toggles a reaction locally and rolls back on failure", () => {
    const snapshot = [...messages];
    const optimistic = applyOptimisticReaction(
      messages as import("./chat.js").ChatMessage[],
      "msg_2",
      "👍",
      LOCAL_REACTOR_ID,
    );
    expect(optimistic[1]?.reactions?.["👍"]).toEqual([LOCAL_REACTOR_ID]);
    expect(rollbackMessages(optimistic, snapshot)).toEqual(snapshot);
  });
});

describe("optimistic message", () => {
  it("uses the request nonce and keeps replies and files visible during the round-trip", () => {
    expect(
      buildOptimisticUserMessage({
        clientNonce: "nonce-1",
        text: "olha isto",
        replyToId: "msg_2",
        createdAt: "2026-08-21T12:00:00.000Z",
        attachments: [
          {
            id: "file-1",
            name: "print.png",
            mimeType: "image/png",
            size: 42,
            image: true,
          },
        ],
      }),
    ).toEqual({
      id: "optimistic:nonce-1",
      clientNonce: "nonce-1",
      role: "user",
      blocks: [
        { kind: "text", text: "olha isto" },
        {
          kind: "file",
          artifactId: "file-1",
          name: "print.png",
          mimeType: "image/png",
          size: 42,
          image: true,
        },
      ],
      replyToId: "msg_2",
      createdAt: "2026-08-21T12:00:00.000Z",
    });
  });
});

describe("versionsByParent", () => {
  it("groups sibling edits under the same parent", () => {
    const index = versionsByParent(messages);
    expect(versionsOf(index, messages[2]!).map((row) => row.id)).toEqual(["msg_3", "msg_4"]);
  });
});

describe("chatTimeLabel", () => {
  it("formats same-day messages as Today HH:mm", () => {
    const iso = "2026-08-13T15:04:00.000Z";
    const date = new Date(iso);
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    expect(chatTimeLabel(iso, date)).toBe(`Hoje ${hh}:${mm}`);
  });

  it("formats the previous day as Yesterday HH:mm", () => {
    const iso = new Date(2026, 7, 12, 15, 4).toISOString();
    const now = new Date(2026, 7, 13, 9, 0);
    expect(chatTimeLabel(iso, now)).toBe("Ontem 15:04");
  });

  it("handles Yesterday across a month boundary", () => {
    const iso = new Date(2026, 1, 28, 12, 30).toISOString();
    const now = new Date(2026, 2, 1, 12, 0);
    expect(chatTimeLabel(iso, now)).toBe("Ontem 12:30");
  });

  it("keeps the short date for anything older", () => {
    const iso = new Date(2026, 7, 1, 12, 0).toISOString();
    const now = new Date(2026, 7, 13, 12, 0);
    expect(chatTimeLabel(iso, now)).toBe("ago 1 12:00");
  });

  it("returns null when there is no timestamp", () => {
    expect(chatTimeLabel(undefined)).toBeNull();
  });
});

describe("bundling and peer line", () => {
  it("bundles consecutive messages from the same speaker", () => {
    const first = { id: "1", role: "bot", fromBotId: "bot_ada" };
    const second = { id: "2", role: "bot", fromBotId: "bot_ada" };
    const user = { id: "3", role: "user" };
    expect(bundledWithPrevious(first, second)).toBe(true);
    expect(bundledWithPrevious(second, user)).toBe(false);
  });

  it("shows a peer line for another bot", () => {
    expect(
      peerLine({ id: "1", role: "bot", fromBotId: "bot_ada" }, "bot_chief", [
        { id: "bot_ada", name: "Ada" },
      ]),
    ).toBe("Mensagem de Ada");
    expect(peerLine({ id: "1", role: "user" }, "bot_chief", [])).toBeNull();
  });

  it("stamps the first message of a new day", () => {
    const prev = { id: "1", role: "bot", createdAt: "2026-08-12T12:00:00.000Z" };
    const next = { id: "2", role: "bot", createdAt: "2026-08-13T12:00:00.000Z" };
    expect(shouldShowTimeStamp(undefined, next)).toBe(true);
    expect(shouldShowTimeStamp(prev, next)).toBe(true);
    expect(shouldShowTimeStamp(next, { ...next, id: "3" })).toBe(false);
  });
});
