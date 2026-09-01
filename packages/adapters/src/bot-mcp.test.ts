import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateBotMcpInput } from "@quibt/db";
import { describe, expect, it, vi } from "vitest";
import { connectBotMcpServers, type RuntimeBotMcpServer } from "./bot-mcp.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "bot-mcp-stdio-fixture.mjs",
);

function server(overrides: Partial<RuntimeBotMcpServer> = {}): RuntimeBotMcpServer {
  return {
    id: "server",
    workspaceId: "workspace",
    botId: "bot",
    name: "Notas locais",
    transport: "stdio",
    command: process.execPath,
    args: [fixture],
    url: null,
    env: {},
    enabled: true,
    ...overrides,
  };
}

describe("per-bot MCP runtime", () => {
  it("discovers and calls stdio tools with the server prefix", async () => {
    const disable = vi.fn(async (_server: RuntimeBotMcpServer, _reason: string) => undefined);
    const runtime = await connectBotMcpServers([server()], { disable });
    try {
      expect(disable).not.toHaveBeenCalled();
      expect(runtime.tools.map((tool) => tool.name)).toEqual(["mcp__Notas_locais__echo"]);
      await expect(runtime.call("mcp__Notas_locais__echo", { text: "oi" })).resolves.toEqual({
        content: [{ type: "text", text: "oi" }],
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps a remote tool named shell behind its collision-safe prefix", async () => {
    const runtime = await connectBotMcpServers([server({ args: [fixture, "--collision"] })]);
    try {
      expect(runtime.tools.map((tool) => tool.name)).toEqual(["mcp__Notas_locais__shell"]);
      expect(runtime.tools.some((tool) => tool.name === "shell")).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  it("redacts explicitly configured environment values from server data and results", async () => {
    const secret = "fixture-secret-value";
    const runtime = await connectBotMcpServers([server({ env: { FIXTURE_SECRET: secret } })]);
    try {
      expect(JSON.stringify(runtime.tools)).not.toContain(secret);
      const result = await runtime.call("mcp__Notas_locais__echo", { text: "oi" });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).toContain("[redacted]");
    } finally {
      await runtime.dispose();
    }
  });

  it("disables a failed spawn and continues with no tools", async () => {
    const disable = vi.fn(async (_server: RuntimeBotMcpServer, _reason: string) => undefined);
    const runtime = await connectBotMcpServers(
      [server({ command: "quibt-command-that-does-not-exist", args: [] })],
      { disable },
    );
    expect(runtime.tools).toEqual([]);
    expect(disable).toHaveBeenCalledOnce();
    expect(disable.mock.calls[0]?.[1]).not.toContain("undefined");
    await runtime.dispose();
  });

  it("refuses cleartext HTTP and accepts HTTPS shape without fetching", () => {
    const base = { workspaceId: "workspace", botId: "bot", name: "Remote", args: [] };
    expect(() => validateBotMcpInput({ ...base, url: "http://example.com/mcp" })).toThrow(/HTTPS/);
    expect(() => validateBotMcpInput({ ...base, url: "http://127.0.0.1:9/mcp" })).toThrow(/HTTPS/);
    expect(validateBotMcpInput({ ...base, url: "https://example.com/mcp" }).transport).toBe("http");
  });
});
