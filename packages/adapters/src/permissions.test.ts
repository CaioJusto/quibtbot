import { describe, expect, it } from "vitest";
import {
  approvalKey,
  autoDecision,
  decideToolPermission,
  looksDestructive,
  looksSensitive,
  parsePermissionAnswer,
  parsePermissionCheckpoint,
} from "./permissions.js";

describe("permission broker", () => {
  it("flags classic destructive and payment commands", () => {
    expect(looksDestructive("rm -rf /")).toBe(true);
    expect(looksDestructive("git push --force origin main")).toBe(true);
    expect(looksDestructive("charge the card and send a payout")).toBe(true);
    expect(looksDestructive("ls -la")).toBe(false);
  });

  it("flags secret-file reads", () => {
    expect(looksSensitive("cat ~/.ssh/id_rsa")).toBe(true);
    expect(looksSensitive("notes/result.txt")).toBe(false);
  });

  it("never auto-approves a destructive command", () => {
    expect(autoDecision({ autoApprove: true }, "shell", "rm -rf /")).toBeNull();
    expect(
      autoDecision({ autoApprove: true, alwaysAllow: ["shell:rm"] }, "shell", "rm -rf scratch"),
    ).toBeNull();
  });

  it("auto-approves a safe shell when the bot is in auto mode", () => {
    expect(autoDecision({ autoApprove: true }, "shell", "ls -la")).toBe("auto-approved shell");
  });

  it("keys command tools by exact operation so Always allow stays narrow", () => {
    expect(approvalKey("shell", "git status")).toMatch(/^shell:exact:[a-f0-9]{64}$/);
    expect(approvalKey("shell", "git status")).not.toBe(
      approvalKey("shell", "git status; python -c exploit"),
    );
    expect(approvalKey("memory", "add")).toBe("memory");
    expect(approvalKey("remember", "fact")).toBe("remember");
  });

  it("asks for shell unless auto-approved or one-shot", () => {
    const ask = decideToolPermission({}, "shell", { command: "ls" });
    expect(ask.action).toBe("ask");
    const once = decideToolPermission({}, "shell", { command: "ls" }, approvalKey("shell", "ls"));
    expect(once).toEqual({ action: "allow", reason: "allow-once" });
  });

  it("parses answers and checkpoints", () => {
    expect(parsePermissionAnswer("Always allow")).toBe("always");
    expect(parsePermissionAnswer("deny")).toBe("deny");
    expect(
      parsePermissionCheckpoint('{"kind":"permission","tool":"shell","approvalKey":"shell:ls"}'),
    ).toMatchObject({ kind: "permission", tool: "shell" });
    expect(parsePermissionCheckpoint("nope")).toBeNull();
  });
});
