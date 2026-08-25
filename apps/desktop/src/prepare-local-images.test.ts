import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(
  path.resolve(import.meta.dirname, "../scripts/prepare-local-images.mjs"),
  "utf8",
);

describe("local installer image preparation", () => {
  it("reuses prepared release tags unless a rebuild is explicitly requested", () => {
    expect(script).toContain('["image", "inspect", tag]');
    expect(script).toContain('process.env.QUIBT_REBUILD_LOCAL_IMAGES !== "1"');
    expect(script).toContain("Using prepared local installer image");
  });
});
