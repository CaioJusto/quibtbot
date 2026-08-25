import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const describeFast = process.env.VERIFY_PROVIDERS ? describe.skip : describe;

describeFast("pnpm verify:fast emulator pin", () => {
  it("forces scripted runtime, fake sandbox, and in-memory wakeup", () => {
    expect(process.env.AGENT_RUNTIME).toBe("scripted");
    expect(process.env.SANDBOX_PROVIDER).toBe("fake");
    expect(process.env.WAKEUP_DRIVER).toBe("memory");
  });

  it("does not keep a live Composio key in the test process", () => {
    expect(process.env.COMPOSIO_API_KEY).toBeUndefined();
  });

  it("runs through vitest rather than the live-provider canary CLI", () => {
    const pkg = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["verify:fast"]).toBe("vitest run");
    expect(pkg.scripts["verify:providers"]).toContain("verify.ts --providers");
  });
});
