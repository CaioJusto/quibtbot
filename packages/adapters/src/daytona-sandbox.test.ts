import type { AdapterContext, ProcessEvent } from "@quibt/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  DAYTONA_NOVNC_PORT,
  type DaytonaClientLike,
  type DaytonaSandboxLike,
  DaytonaSandboxProvider,
  daytonaCreateOptions,
  daytonaNoVncUrl,
} from "./daytona-sandbox.js";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  workspaceId: "workspace-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

function harness(state = "started") {
  const executeCommand = vi.fn(async () => ({ exitCode: 0, result: "" }));
  const createSession = vi.fn(async () => undefined);
  const executeSessionCommand = vi.fn(async () => ({
    stdout: "out\n",
    stderr: "warn\n",
    exitCode: 7,
  }));
  const deleteSession = vi.fn(async () => undefined);
  const computerUseStart = vi.fn(async () => undefined);
  const computerUseStop = vi.fn(async () => undefined);
  const keyPress = vi.fn(async () => undefined);
  const keyType = vi.fn(async () => undefined);
  const mouseMove = vi.fn(async () => ({ x: 4, y: 5 }));
  const mouseClick = vi.fn(async () => ({}));
  const screenshot = vi.fn(async () => ({ data: "image" }));
  const expireSignedPreviewUrl = vi.fn(async () => undefined);
  const sandbox: DaytonaSandboxLike = {
    id: "daytona-1",
    state,
    getUserHomeDir: vi.fn(async () => "/home/daytona"),
    process: {
      executeCommand,
      createSession,
      executeSessionCommand,
      deleteSession,
    },
    computerUse: {
      start: computerUseStart,
      stop: computerUseStop,
      keyboard: { press: keyPress, type: keyType },
      mouse: {
        getPosition: vi.fn(async () => ({ x: 10, y: 20 })),
        move: mouseMove,
        click: mouseClick,
      },
      screenshot: { takeFullScreen: screenshot },
    },
    getSignedPreviewUrl: vi.fn(async () => ({
      url: "https://6080-token.proxy.daytona.work",
      token: "screen-token",
    })),
    expireSignedPreviewUrl,
  };
  const client: DaytonaClientLike = {
    create: vi.fn(async () => sandbox),
    get: vi.fn(async () => sandbox),
    start: vi.fn(async (box) => {
      box.state = "started";
    }),
    stop: vi.fn(async (box) => {
      box.state = "stopped";
    }),
    delete: vi.fn(async () => undefined),
  };
  return {
    provider: new DaytonaSandboxProvider("daytona_test", {
      client,
      screenTtlSeconds: 900,
    }),
    sandbox,
    client,
    executeCommand,
    createSession,
    executeSessionCommand,
    deleteSession,
    computerUseStart,
    computerUseStop,
    keyPress,
    keyType,
    mouseMove,
    mouseClick,
    screenshot,
    expireSignedPreviewUrl,
  };
}

async function collect(events: AsyncIterable<ProcessEvent>) {
  const collected: ProcessEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("DaytonaSandboxProvider", () => {
  it("creates a private persistent sandbox from the default graphical image", async () => {
    const h = harness();
    const ref = await h.provider.provision(
      { botId: "bot-1", homePath: "/unused/on-provider" },
      context,
    );

    expect(ref).toEqual({
      id: "daytona-1",
      botId: "bot-1",
      kind: "daytona",
      providerRef: "daytona-1",
    });
    expect(h.client.create).toHaveBeenCalledWith(daytonaCreateOptions("bot-1"), { timeout: 120 });
    expect(h.computerUseStart).toHaveBeenCalled();
    expect(h.executeCommand).toHaveBeenCalledWith(
      expect.stringContaining("google-chrome"),
      "/home/daytona",
      undefined,
      10,
    );
  });

  it("keeps stdout and stderr separate and remaps the Docker home", async () => {
    const h = harness();
    const ref = await h.provider.provision({ botId: "bot-1", homePath: "/unused" }, context);
    const events = await collect(
      h.provider.execute(
        ref,
        {
          argv: ["bash", "-lc", "printf ok"],
          cwd: "/home/quibt/project",
          env: { HELLO: "world value" },
          timeoutMs: 2_500,
        },
        context,
      ),
    );

    expect(events).toEqual([
      { type: "stdout", data: "out\n" },
      { type: "stderr", data: "warn\n" },
      { type: "exit", code: 7 },
    ]);
    expect(h.createSession).toHaveBeenCalledWith(expect.stringMatching(/^quibt-/));
    expect(h.executeSessionCommand).toHaveBeenCalledWith(
      expect.any(String),
      {
        command: "cd /home/daytona/project && env 'HELLO=world value' printf ok",
        runAsync: false,
        suppressInputEcho: true,
      },
      3,
    );
    expect(h.deleteSession).toHaveBeenCalled();
  });

  it("opens signed noVNC, drives computer use, and revokes the preview token", async () => {
    const h = harness();
    const ref = await h.provider.provision({ botId: "bot-1", homePath: "/unused" }, context);
    const screen = await h.provider.connectScreen(ref, { view: "stream" }, context);
    expect(screen.url).toBe(
      "https://6080-token.proxy.daytona.work/vnc.html?autoconnect=1&resize=scale",
    );
    expect(h.sandbox.getSignedPreviewUrl).toHaveBeenCalledWith(DAYTONA_NOVNC_PORT, 900);

    await h.provider.sendInput(
      ref,
      { kind: "key", key: "c", modifiers: ["ctrl"] },
      { leaseId: "lease", holder: "user", fence: 1 },
      context,
    );
    await h.provider.sendInput(
      ref,
      { kind: "pointer", type: "moveRelative", x: 2, y: -3 },
      { leaseId: "lease", holder: "user", fence: 1 },
      context,
    );
    await h.provider.sendInput(
      ref,
      { kind: "clipboard", text: "pasted text" },
      { leaseId: "lease", holder: "user", fence: 1 },
      context,
    );
    expect(h.keyPress).toHaveBeenCalledWith("c", ["ctrl"]);
    expect(h.mouseMove).toHaveBeenCalledWith(12, 17);
    expect(h.keyType).toHaveBeenCalledWith("pasted text");

    await screen.close();
    expect(h.expireSignedPreviewUrl).toHaveBeenCalledWith(DAYTONA_NOVNC_PORT, "screen-token");
  });

  it("stops, restarts, snapshots, and deletes the same sandbox", async () => {
    const h = harness();
    const ref = await h.provider.provision({ botId: "bot-1", homePath: "/unused" }, context);
    await h.provider.stop(ref, context);
    expect(h.computerUseStop).toHaveBeenCalled();
    expect(h.client.stop).toHaveBeenCalledWith(h.sandbox);
    expect(await h.provider.presence(ref, context)).toBe("stopped");

    const restarted = await h.provider.start(ref, context);
    expect(h.client.start).toHaveBeenCalledWith(h.sandbox, 120);
    expect(restarted.providerRef).toBe(ref.providerRef);
    expect(await h.provider.snapshot(ref, context)).toMatchObject({
      id: expect.stringContaining("daytona-daytona-1-"),
    });
    expect(h.screenshot).toHaveBeenCalledWith(true);

    await h.provider.destroy(ref, context);
    expect(h.client.delete).toHaveBeenCalledWith(h.sandbox, 60, true);
  });

  it("replaces an irrecoverably missing saved reference", async () => {
    const h = harness();
    vi.mocked(h.client.get).mockRejectedValueOnce(new Error("404 sandbox not found"));
    const ref = await h.provider.provision(
      { botId: "bot-1", homePath: "/unused", providerRef: "gone" },
      context,
    );
    expect(ref.providerRef).toBe("daytona-1");
    expect(h.client.create).toHaveBeenCalledTimes(1);
  });

  it("deletes a newly created sandbox if desktop preparation fails", async () => {
    const h = harness();
    h.computerUseStart.mockRejectedValueOnce(new Error("VNC unavailable"));
    await expect(
      h.provider.provision({ botId: "bot-1", homePath: "/unused" }, context),
    ).rejects.toThrow("VNC unavailable");
    expect(h.client.delete).toHaveBeenCalledWith(h.sandbox, 60, true);
  });
});

describe("Daytona helpers", () => {
  it("builds the noVNC path without discarding a signed preview query", () => {
    expect(daytonaNoVncUrl("https://preview.example/base?signature=abc")).toBe(
      "https://preview.example/base/vnc.html?signature=abc&autoconnect=1&resize=scale",
    );
  });
});
