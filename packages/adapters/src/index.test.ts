import { describe, expect, it } from "vitest";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { inferScript } from "./scripted-runtime.js";
import { EncryptedSecretStore } from "./secrets.js";

describe("secret store", () => {
  it("round-trips and never stores plaintext in ciphertext", async () => {
    const store = new EncryptedSecretStore("test-key");
    const record = await store.put("sk-or-v1-secretvalue", {
      operationId: "1",
      traceId: "1",
      workspaceId: "w",
      userId: "u",
      signal: new AbortController().signal,
    });
    expect(record.ciphertext).not.toContain("sk-or-v1-secretvalue");
    expect(store.load(record.ciphertext)).toBe("sk-or-v1-secretvalue");
  });
});

describe("scripted runtime", () => {
  it("requests takeover for login work", () => {
    const script = inferScript("install the cli and sign in");
    expect(script?.some((t) => t.takeover)).toBe(true);
  });

  it("resumes after takeover without asking again", () => {
    const script = inferScript("install the cli and sign in", "takeover");
    expect(script?.some((t) => t.takeover)).toBe(false);
    expect(script?.some((t) => t.complete)).toBe(true);
  });

  it("routes destination/crm work through the connector", () => {
    const script = inferScript("write this to the destination crm as a note");
    expect(script?.some((t) => t.toolCalls?.some((c) => c.name === "destination.write"))).toBe(
      true,
    );
  });

  it("spawns a named bot", () => {
    const script = inferScript("spawn a bot named Scout to research venues");
    expect(script?.some((t) => t.toolCalls?.some((c) => c.name === "spawn_bot"))).toBe(true);
    expect(script?.some((t) => t.toolCalls?.some((c) => c.args.name === "Scout"))).toBe(true);
  });

  it("runs an in-thread subagent", () => {
    const script = inferScript("run a subagent to summarize the notes");
    expect(script?.some((t) => t.toolCalls?.some((c) => c.name === "run_subagent"))).toBe(true);
  });

  it("asks a teammate and waits for the reply", () => {
    const script = inferScript("ask_bot Writer: what is the launch headline?");
    expect(
      script?.some((t) =>
        t.toolCalls?.some(
          (c) =>
            c.name === "ask_bot" &&
            c.args.name === "Writer" &&
            String(c.args.message).includes("launch headline"),
        ),
      ),
    ).toBe(true);
    expect(script?.some((t) => t.complete)).toBe(false);
  });

  it("sends a fire-and-forget recado", () => {
    const script = inferScript("message_teammate Writer: draft the note");
    expect(
      script?.some((t) =>
        t.toolCalls?.some((c) => c.name === "message_teammate" && c.args.name === "Writer"),
      ),
    ).toBe(true);
  });

  it("deletes a spawned bot by exact name", () => {
    const script = inferScript("delete the bot named Scout");
    expect(
      script?.some((t) =>
        t.toolCalls?.some((c) => c.name === "delete_bot" && c.args.confirm_name === "Scout"),
      ),
    ).toBe(true);
  });
});

describe("builtin tools", () => {
  it("exposes the tools the executor actually applies", async () => {
    const { builtinAgentTools, collaborationAgentTools } = await import("./builtin-tools.js");
    expect(builtinAgentTools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "write_file",
        "shell",
        "open_url",
        "memory",
        "remember",
        "save_skill",
        "create_routine",
        "request_takeover",
        "run_subagent",
        "spawn_bot",
        "delete_bot",
      ]),
    );
    expect(collaborationAgentTools.map((t) => t.name)).toEqual([
      "list_teammates",
      "list_bots",
      "message_teammate",
      "ask_bot",
    ]);
  });
});

describe("fake sandbox", () => {
  it("provisions one workspace machine with isolated bot desktops", async () => {
    const sandbox = new FakeSandboxProvider();
    const ctx = {
      operationId: "1",
      traceId: "1",
      workspaceId: "w",
      userId: "u",
      signal: new AbortController().signal,
    };
    const a = await sandbox.provision({ botId: "a", homePath: "/tmp/a" }, ctx);
    const b = await sandbox.provision({ botId: "b", homePath: "/tmp/b" }, ctx);
    expect(a.providerRef).toBe(b.providerRef);
    expect(a.display).not.toBe(b.display);
    expect(a.screenUrl).not.toBe(b.screenUrl);
  });
});
