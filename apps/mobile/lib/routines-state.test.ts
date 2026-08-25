import { describe, expect, it } from "vitest";
import type { MobileRoutine } from "./api.js";
import { withoutRoutine } from "./routines-state.js";

function routine(id: string): MobileRoutine {
  return {
    id,
    name: id,
    prompt: "work",
    cron: "0 9 * * *",
    timezone: "UTC",
    active: true,
    notify: true,
  };
}

describe("withoutRoutine", () => {
  it("removes a routine without mutating the rollback snapshot", () => {
    const original = [routine("one"), routine("two")];
    const next = withoutRoutine(original, "one");
    expect(next.map((row) => row.id)).toEqual(["two"]);
    expect(original.map((row) => row.id)).toEqual(["one", "two"]);
  });
});
