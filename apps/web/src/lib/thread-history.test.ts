import type { ThreadMessage } from "@quibt/contracts";
import { describe, expect, it } from "vitest";
import {
  HISTORY_PAGE_LIMIT,
  lastUserMessageSeq,
  mergeThreadMessages,
  oldestMessageSeq,
  pageHasMore,
  readThreadCursors,
  unreadDivider,
  writeThreadCursor,
} from "./thread-history.js";

function message(id: string, seq: number, role: ThreadMessage["role"] = "bot"): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    seq,
    role,
    blocks: [{ kind: "text", text: id }],
    createdAt: "2026-08-26T12:00:00.000Z",
  };
}

describe("thread history", () => {
  it("merges an older page with the live window in chronological order", () => {
    const merged = mergeThreadMessages(
      [message("m1", 1), message("m2", 2)],
      [message("m2", 2), message("m3", 3)],
    );
    expect(merged.map((row) => row.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("ignores transient rows when choosing the older-page cursor", () => {
    expect(oldestMessageSeq([message("progress:r", 1), message("m2", 2)])).toBe(2);
    expect(oldestMessageSeq([message("subagent:a", 1)])).toBeNull();
  });

  it("places one divider before all durable messages not seen yet", () => {
    expect(unreadDivider([message("m1", 1), message("m2", 2), message("m3", 3)], 1)).toEqual({
      firstMessageId: "m2",
      count: 2,
    });
    expect(unreadDivider([message("progress:r", 4)], 1)).toBeNull();
  });

  it("uses the last user message as the legacy unread fallback", () => {
    expect(
      lastUserMessageSeq([
        message("m1", 1, "user"),
        message("m2", 2),
        message("m3", 3, "user"),
        message("m4", 4),
      ]),
    ).toBe(3);
  });

  it("trusts the server about older pages and ignores live projections in the fallback", () => {
    expect(pageHasMore(true, [])).toBe(true);
    expect(
      pageHasMore(
        false,
        Array.from({ length: 80 }, (_, seq) => message(`m${seq}`, seq)),
      ),
    ).toBe(false);
    // Servidor antigo, sem o campo: uma janela cheia de projeções vivas não é página cheia.
    const durable = Array.from({ length: HISTORY_PAGE_LIMIT - 1 }, (_, seq) =>
      message(`m${seq}`, seq),
    );
    expect(pageHasMore(undefined, [...durable, message("progress:r", 99)])).toBe(false);
    expect(pageHasMore(undefined, [...durable, message("m-full", 99)])).toBe(true);
  });

  it("keeps cursors isolated by account and tolerates corrupt storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    writeThreadCursor(storage, "account-a", "bot:1", 7);
    writeThreadCursor(storage, "account-b", "bot:1", 2);
    expect(readThreadCursors(storage, "account-a")).toEqual({ "bot:1": 7 });
    expect(readThreadCursors(storage, "account-b")).toEqual({ "bot:1": 2 });

    values.set("quibt.thread-read.v1", "not json");
    expect(readThreadCursors(storage, "account-a")).toEqual({});
  });
});
