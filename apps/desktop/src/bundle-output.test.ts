import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("desktop bundle output", () => {
  it("bundles workspace installer without typescript workspace imports", () => {
    execFileSync("node", [path.join(desktopRoot, "scripts/bundle.mjs")], {
      cwd: desktopRoot,
      stdio: "pipe",
    });
    const main = readFileSync(path.join(desktopRoot, "dist/main.js"), "utf8");
    expect(main).not.toMatch(/@quibt\/installer\/src/);
    expect(main).not.toMatch(/from ["']@quibt\/[^"']+\.ts["']/);
    expect(main).not.toMatch(/require\(["']@quibt\/[^"']+\.ts["']\)/);
    expect(main.length).toBeGreaterThan(10_000);
  });
});
