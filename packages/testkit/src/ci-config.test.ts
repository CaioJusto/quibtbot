import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ciWorkflow = readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8");

/**
 * Every public client (web, mobile, www, desktop) must have an explicit CI command that
 * actually exercises it. A green pipeline should mean every client was built or checked,
 * not just that the workspace root happened to compile.
 */
describe("CI covers every public client explicitly", () => {
  it("type-checks the mobile app", () => {
    expect(ciWorkflow).toContain("pnpm --filter @quibt/mobile check");
  });

  it("builds the marketing site", () => {
    expect(ciWorkflow).toContain("pnpm --filter @quibt/www build");
  });

  it("runs the installer verification suite", () => {
    expect(ciWorkflow).toContain("pnpm verify:installer");
  });

  it("packages the desktop app with electron-builder --dir, not just a script syntax check", () => {
    expect(ciWorkflow).toMatch(
      /electron-builder --dir|pnpm --filter @quibt\/desktop (run )?pack:dir/,
    );
  });

  it("runs the mobile end-to-end suite in its supported (scripted/fake) environment", () => {
    expect(ciWorkflow).toContain("pnpm e2e:mobile");
  });
});
