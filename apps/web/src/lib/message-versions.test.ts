import { messageVersions } from "@quibt/core";
import { describe, expect, it } from "vitest";
import { versionsByParent, versionsOf } from "./message-versions.js";

type Row = { id: string; parentId?: string | null; role: string };

const thread: Row[] = [
  { id: "m1", role: "user" },
  { id: "m2", role: "bot", parentId: "m1" },
  { id: "m3", role: "user", parentId: "m2" },
  { id: "m4", role: "user", parentId: "m2" },
  { id: "m5", role: "bot", parentId: "m4" },
  { id: "m6", role: "user" },
];

describe("versionsByParent", () => {
  it("matches messageVersions for every message in the thread", () => {
    const index = versionsByParent(thread);
    for (const message of thread) {
      expect(versionsOf(index, message)).toEqual(messageVersions(thread, message));
    }
  });

  it("keeps the edit branch of a message with its siblings, in thread order", () => {
    const index = versionsByParent(thread);
    expect(versionsOf(index, thread[2]!).map((row) => row.id)).toEqual(["m3", "m4"]);
    expect(versionsOf(index, thread[3]!).findIndex((row) => row.id === "m4")).toBe(1);
  });

  it("does not mix a bot reply into the user branch under the same parent", () => {
    const index = versionsByParent([
      { id: "a", role: "user", parentId: "p" },
      { id: "b", role: "bot", parentId: "p" },
    ]);
    expect(
      versionsOf(index, { id: "a", role: "user", parentId: "p" }).map((row) => row.id),
    ).toEqual(["a"]);
  });

  it("indexes the whole thread in a single pass", () => {
    const big: Row[] = Array.from({ length: 2_000 }, (_, i) => ({
      id: `m${i}`,
      role: "user",
      parentId: `p${i % 4}`,
    }));
    let reads = 0;
    const counted = big.map((row) => {
      return new Proxy(row, {
        get(target, key: keyof Row) {
          reads += 1;
          return target[key];
        },
      }) as Row;
    });
    const index = versionsByParent(counted);
    for (const row of counted) versionsOf(index, row);
    // Two field reads per row to index it, two more per lookup — never n² scans.
    expect(reads).toBeLessThanOrEqual(counted.length * 6);
    expect(index.size).toBe(4);
  });

  it("returns an empty branch for a message that is not in the thread", () => {
    expect(versionsOf(versionsByParent(thread), { id: "x", role: "system" })).toEqual([]);
  });
});
