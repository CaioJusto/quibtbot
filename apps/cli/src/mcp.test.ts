import { describe, expect, it, vi } from "vitest";
import {
  handleMcpMessage,
  McpConfigurationError,
  McpControlPlane,
  resolveMcpConnection,
} from "./mcp.js";

function rpcResponse(json: unknown, status = 200): Response {
  return new Response(JSON.stringify({ json }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeControlPlane(
  handler: (procedure: string, input: Record<string, unknown>) => unknown | Promise<unknown>,
) {
  const requests: Array<{ procedure: string; input: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const procedure = url.pathname.replace(/^\/rpc\//, "");
    const body = JSON.parse(String(init?.body ?? "{}")) as { json?: Record<string, unknown> };
    requests.push({ procedure, input: body.json ?? {} });
    return rpcResponse(await handler(procedure, body.json ?? {}));
  }) as unknown as typeof fetch;
  return {
    requests,
    control: new McpControlPlane({
      fetch: fetchImpl,
      env: { QUIBTBOT_URL: "https://quibt.test", QUIBTBOT_TOKEN: "session-token" },
      sleep: async () => {},
    }),
  };
}

describe("MCP protocol", () => {
  it("lists only the bounded roster tools with strict input schemas", async () => {
    const { control } = fakeControlPlane(() => ({}));
    const response = await handleMcpMessage(control, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const result = response?.result as {
      tools: Array<{ name: string; inputSchema: { additionalProperties?: boolean } }>;
    };
    const names = result.tools.map((tool) => tool.name);
    expect(names).toContain("list_bots");
    expect(names).toContain("set_bot_model");
    expect(names.join(" ")).not.toMatch(
      /approv|delet|credential|pair|computer|lifecycle|settings|team.*pack/i,
    );
    expect(result.tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(
      true,
    );
  });

  it("rejects unknown tools and unknown tool fields", async () => {
    const { control } = fakeControlPlane(() => ({}));
    const unknown = await handleMcpMessage(control, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "delete_bot", arguments: {} },
    });
    expect(unknown?.error).toMatchObject({ code: -32602 });

    await expect(control.callTool("list_bots", { include_credentials: true })).rejects.toThrow(
      /unknown field/i,
    );
  });
});

describe("MCP roster tools", () => {
  it("maps list_bots to the existing RPC and removes approval policy fields", async () => {
    const { control, requests } = fakeControlPlane((procedure) => {
      expect(procedure).toBe("bots/list");
      return [
        {
          id: "bot-1",
          name: "Ada",
          title: "Research",
          description: "Finds evidence",
          status: "idle",
          preview: "Done",
          autoApprove: true,
          alwaysAllow: ["shell"],
        },
      ];
    });
    const result = await control.callTool("list_bots", {});
    expect(requests[0]).toEqual({ procedure: "bots/list", input: {} });
    expect(result).toEqual([expect.objectContaining({ id: "bot-1", name: "Ada", status: "idle" })]);
    expect(JSON.stringify(result)).not.toMatch(/autoApprove|alwaysAllow|shell/);
  });

  it("maps send_bot_message to threads/send", async () => {
    const { control, requests } = fakeControlPlane(() => ({
      taskId: "task-1",
      runId: "run-1",
      seq: 8,
    }));
    await expect(
      control.callTool("send_bot_message", { bot_id: "bot-1", text: "Research this" }),
    ).resolves.toEqual({ taskId: "task-1", runId: "run-1", seq: 8 });
    expect(requests).toEqual([
      {
        procedure: "threads/send",
        input: { botId: "bot-1", text: "Research this" },
      },
    ]);
  });

  it("waits through active statuses and returns attention/completion statuses", async () => {
    const snapshots = [
      { run: { id: "run-1", status: "queued" }, messages: [] },
      { run: { id: "run-1", status: "running" }, messages: [] },
      {
        run: { id: "run-1", status: "waiting_input" },
        messages: [{ id: "m-1", seq: 1, role: "bot", blocks: [{ kind: "text", text: "Choose" }] }],
      },
    ];
    const { control } = fakeControlPlane(() => snapshots.shift());
    await expect(
      control.callTool("wait_for_conversation", {
        bot_id: "bot-1",
        run_id: "run-1",
        timeout_ms: 1_000,
        poll_interval_ms: 100,
      }),
    ).resolves.toMatchObject({ status: "waiting_input" });

    const completedSnapshots = [
      { run: { id: "run-2", status: "running" }, messages: [] },
      { run: null, messages: [{ id: "m-2", role: "bot", blocks: [] }] },
    ];
    const second = fakeControlPlane(() => completedSnapshots.shift()).control;
    await expect(
      second.callTool("wait_for_conversation", {
        bot_id: "bot-1",
        run_id: "run-2",
        timeout_ms: 1_000,
        poll_interval_ms: 100,
      }),
    ).resolves.toMatchObject({ status: "completed", runId: "run-2" });
  });

  it("interrupts through threads/stop", async () => {
    const { control, requests } = fakeControlPlane(() => ({ ok: true }));
    await expect(control.callTool("interrupt_conversation", { bot_id: "bot-1" })).resolves.toEqual({
      ok: true,
    });
    expect(requests).toEqual([{ procedure: "threads/stop", input: { botId: "bot-1" } }]);
  });

  it("interrupts every member of a group through existing bot RPCs", async () => {
    const { control, requests } = fakeControlPlane((procedure) =>
      procedure === "botGroups/get"
        ? { id: "group-1", members: [{ id: "bot-1" }, { id: "bot-2" }] }
        : { ok: true },
    );
    await expect(
      control.callTool("interrupt_conversation", { group_id: "group-1" }),
    ).resolves.toEqual({ ok: true, groupId: "group-1", stopped: 2 });
    expect(requests.map((request) => request.procedure)).toEqual([
      "botGroups/get",
      "threads/stop",
      "threads/stop",
    ]);
  });

  it("refuses set_bot_model while the bot is busy", async () => {
    const { control, requests } = fakeControlPlane(() => ({
      run: { id: "run-1", status: "running" },
    }));
    await expect(
      control.callTool("set_bot_model", {
        bot_id: "bot-1",
        provider: "openrouter",
        model_id: "model-1",
      }),
    ).rejects.toThrow(/busy.*running/i);
    expect(requests.map((request) => request.procedure)).toEqual(["threads/get"]);
  });

  it("strips screenshots, pixels, secrets, and computer state from transcript results", async () => {
    const { control } = fakeControlPlane(() => ({
      botId: "bot-1",
      cursor: 3,
      hasMore: false,
      computer: { state: "running", screenUrl: "https://secret.test/control" },
      messages: [
        {
          id: "message-1",
          seq: 3,
          role: "bot",
          blocks: [
            {
              kind: "computer",
              text: "Looked at the page",
              screenshot: "data:image/png;base64,PIXELS",
              image: "data:image/png;base64,PIXELS2",
              token: "secret-token",
              allowKey: "approval-grant",
            },
          ],
        },
      ],
    }));
    const result = await control.callTool("get_bot_messages", { bot_id: "bot-1" });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("Looked at the page");
    expect(serialized).not.toMatch(/PIXELS|secret-token|approval-grant|screenUrl|computer.*state/);
  });
});

describe("MCP connection policy", () => {
  it("reuses the installer port probe for the default local API", async () => {
    const probePort = vi.fn(async () => true);
    await expect(resolveMcpConnection({ env: {}, probePort })).resolves.toEqual({
      origin: "http://127.0.0.1:3100",
    });
    expect(probePort).toHaveBeenCalledWith(3100);
  });

  it("claims a loopback-only local session before calling authenticated roster RPCs", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/local/session") {
        return new Response(JSON.stringify({ token: "local-session" }), { status: 200 });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer local-session");
      return rpcResponse([]);
    }) as unknown as typeof fetch;
    const control = new McpControlPlane({
      env: {},
      fetch: fetchImpl,
      probePort: async () => true,
    });
    await expect(control.callTool("list_bots", {})).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects cleartext remote HTTP even when no token is configured", async () => {
    await expect(
      resolveMcpConnection({ env: { QUIBTBOT_URL: "http://quibt.example:3100" } }),
    ).rejects.toBeInstanceOf(McpConfigurationError);
  });

  it("requires an explicit URL whenever a bearer token is configured", async () => {
    await expect(
      resolveMcpConnection({ env: { QUIBTBOT_TOKEN: "do-not-probe-with-this" } }),
    ).rejects.toThrow(/requires an explicit QUIBTBOT_URL/i);
  });
});
