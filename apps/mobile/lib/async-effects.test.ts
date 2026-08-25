import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = path.dirname(fileURLToPath(import.meta.url));

function source(relative: string) {
  return readFileSync(path.join(dir, relative), "utf8");
}

describe("parameter-scoped mobile requests", () => {
  for (const screen of ["group-settings.tsx", "settings.tsx"]) {
    it(`ignores stale requests in ${screen}`, () => {
      const code = source(`../app/${screen}`);
      expect(code).toContain("let active = true");
      expect(code).toContain("if (!active) return");
      expect(code).toContain("active = false");
    });
  }
});
