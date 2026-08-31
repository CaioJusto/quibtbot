import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOX_TRIAL_TTL_SECONDS,
  BoxSandboxProvider,
  boxCommandFromArgv,
  isUnrecoverableBoxError,
} from "./box-sandbox.js";

const ctx = {
  operationId: "1",
  traceId: "1",
  workspaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function boxInfo(overrides: Record<string, unknown> = {}) {
  return {
    id: "bx_23456789",
    name: "Box test",
    state: "ready",
    desktopAvailable: true,
    desktopUrl: "https://desktop.example/vnc.html?_token=secret",
    snapshotAvailable: false,
    ...overrides,
  };
}

function mockBoxApi(handler: (req: RecordedRequest, index: number) => Response) {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const req: RecordedRequest = {
        method: init?.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      requests.push(req);
      return handler(req, requests.length - 1);
    }),
  );
  return requests;
}

function provider() {
  return new BoxSandboxProvider("box_test_key", { pollIntervalMs: 1, provisionTimeoutMs: 500 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("boxCommandFromArgv", () => {
  it("unwraps bash -lc so the inner command keeps its quoting", () => {
    expect(boxCommandFromArgv(["bash", "-lc", "echo hi > /tmp/x"])).toBe("echo hi > /tmp/x");
    expect(boxCommandFromArgv(["sh", "-c", "cat file"])).toBe("cat file");
  });

  it("shell-quotes plain argv", () => {
    expect(boxCommandFromArgv(["echo", "graphical-ok"])).toBe("echo graphical-ok");
    expect(boxCommandFromArgv(["echo", "two words"])).toBe("echo 'two words'");
    expect(boxCommandFromArgv(["echo", "it's"])).toBe("echo 'it'\\''s'");
  });
});

describe("isUnrecoverableBoxError", () => {
  it("flags missing boxes and passes transient errors through", () => {
    expect(isUnrecoverableBoxError(new Error("box api GET /boxes/bx failed: 404 not_found"))).toBe(
      true,
    );
    expect(isUnrecoverableBoxError(new Error("box api POST /boxes failed: 429 rate_limited"))).toBe(
      false,
    );
  });
});

describe("BoxSandboxProvider", () => {
  it("creates a distinct box for each bot when no providerRef is supplied", async () => {
    let createCount = 0;
    const requests = mockBoxApi((req) => {
      if (req.method === "POST" && req.path === "/api/box/v1/boxes") {
        createCount += 1;
        const id = createCount === 1 ? "bx_11111111" : "bx_22222222";
        return json({ ok: true, type: "box.created", box: boxInfo({ id, state: "ready" }) });
      }
      if (req.method === "GET" && req.path.includes("bx_11111111")) {
        return json({ ok: true, box: boxInfo({ id: "bx_11111111", state: "ready" }) });
      }
      if (req.method === "GET" && req.path.includes("bx_22222222")) {
        return json({ ok: true, box: boxInfo({ id: "bx_22222222", state: "ready" }) });
      }
      throw new Error(`unexpected request ${req.method} ${req.path}`);
    });
    const p = provider();
    const refA = await p.provision({ botId: "bot-a", homePath: "/tmp/a" }, ctx);
    const refB = await p.provision({ botId: "bot-b", homePath: "/tmp/b" }, ctx);
    expect(refA.providerRef).toBe("bx_11111111");
    expect(refB.providerRef).toBe("bx_22222222");
    expect(refA.providerRef).not.toBe(refB.providerRef);
    expect(
      requests.filter((r) => r.method === "POST" && r.path === "/api/box/v1/boxes"),
    ).toHaveLength(2);
  });

  it("creates a persistent box without inheriting operator environment variables", async () => {
    const requests = mockBoxApi((req) => {
      if (req.method === "POST" && req.path === "/api/box/v1/boxes") {
        return json({ ok: true, type: "box.created", box: boxInfo({ state: "provisioning" }) });
      }
      if (req.method === "GET" && req.path === "/api/box/v1/boxes/bx_23456789") {
        const polls = requests.filter((r) => r.method === "GET").length;
        return json({ ok: true, box: boxInfo({ state: polls < 2 ? "provisioning" : "ready" }) });
      }
      throw new Error(`unexpected request ${req.method} ${req.path}`);
    });
    const ref = await provider().provision({ botId: "bot-1", homePath: "/tmp/h" }, ctx);
    expect(ref).toMatchObject({
      id: "bx_23456789",
      botId: "bot-1",
      kind: "box",
      providerRef: "bx_23456789",
      screenUrl: "https://desktop.example/vnc.html?_token=secret",
    });
    const create = requests.find((r) => r.method === "POST" && r.path === "/api/box/v1/boxes");
    expect(create?.body).toEqual({ ttlSeconds: null, noEnv: true });
    expect(requests.filter((r) => r.method === "GET").length).toBeGreaterThanOrEqual(2);
  });

  it("retries a free-trial Box with the provider's two-hour auto-stop maximum", async () => {
    const requests = mockBoxApi((req) => {
      if (req.method === "POST" && req.path === "/api/box/v1/boxes") {
        if ((req.body as { ttlSeconds?: number | null }).ttlSeconds === null) {
          return json(
            {
              ok: false,
              code: "trial_auto_stop_required",
              message: "Free-trial Boxes cannot run without auto-stop",
            },
            400,
          );
        }
        return json({ ok: true, type: "box.created", box: boxInfo() });
      }
      if (req.method === "GET" && req.path === "/api/box/v1/boxes/bx_23456789") {
        return json({ ok: true, box: boxInfo() });
      }
      throw new Error(`unexpected request ${req.method} ${req.path}`);
    });

    await provider().provision({ botId: "bot-trial", homePath: "/tmp/trial" }, ctx);

    expect(
      requests
        .filter((request) => request.method === "POST" && request.path === "/api/box/v1/boxes")
        .map((request) => request.body),
    ).toEqual([
      { ttlSeconds: null, noEnv: true },
      { ttlSeconds: BOX_TRIAL_TTL_SECONDS, noEnv: true },
    ]);
  });

  it("does not expose the Box response body in request errors", async () => {
    mockBoxApi(() =>
      json(
        {
          ok: false,
          code: "invalid_api_key",
          message: "secret provider diagnostics",
          key: "box_should_not_leak",
        },
        401,
      ),
    );

    const failure = await provider()
      .provision({ botId: "bot-1", homePath: "/tmp/h" }, ctx)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 401, code: "invalid_api_key" });
    expect((failure as Error).message).toBe("box api POST /boxes failed: 401 invalid_api_key");
    expect((failure as Error).message).not.toContain("box_should_not_leak");
  });

  it("resumes an archived box when reconnecting by providerRef", async () => {
    let resumed = false;
    const requests = mockBoxApi((req) => {
      if (req.method === "GET") {
        return json({ ok: true, box: boxInfo({ state: resumed ? "ready" : "archived" }) });
      }
      if (req.method === "POST" && req.path === "/api/box/v1/boxes/bx_23456789/resume") {
        resumed = true;
        return json({ ok: true, type: "box.resuming", id: "bx_23456789" }, 202);
      }
      throw new Error(`unexpected request ${req.method} ${req.path}`);
    });
    const ref = await provider().provision(
      { botId: "bot-1", homePath: "/tmp/h", providerRef: "bx_23456789" },
      ctx,
    );
    expect(ref.providerRef).toBe("bx_23456789");
    expect(requests.some((r) => r.path.endsWith("/resume"))).toBe(true);
    expect(requests.some((r) => r.method === "POST" && r.path === "/api/box/v1/boxes")).toBe(false);
  });

  it("creates a fresh box when the stored providerRef is gone", async () => {
    mockBoxApi((req) => {
      if (req.method === "GET" && req.path === "/api/box/v1/boxes/bx_gone") {
        return json({ ok: false, error: "not_found" }, 404);
      }
      if (req.method === "POST" && req.path === "/api/box/v1/boxes") {
        return json({ ok: true, box: boxInfo() });
      }
      if (req.method === "GET" && req.path === "/api/box/v1/boxes/bx_23456789") {
        return json({ ok: true, box: boxInfo() });
      }
      throw new Error(`unexpected request ${req.method} ${req.path}`);
    });
    const ref = await provider().provision(
      { botId: "bot-1", homePath: "/tmp/h", providerRef: "bx_gone" },
      ctx,
    );
    expect(ref.providerRef).toBe("bx_23456789");
  });

  it("executes commands with a cd wrapper and maps the result to process events", async () => {
    const requests = mockBoxApi((req) => {
      if (req.method === "POST" && req.path === "/api/box/v1/boxes/bx_23456789/commands") {
        return json({
          ok: true,
          type: "command.finished",
          success: true,
          exitCode: 0,
          stdout: "graphical-ok\n",
          stderr: "",
          timedOut: false,
        });
      }
      throw new Error(`unexpected request ${req.method} ${req.path}`);
    });
    const computer = {
      id: "bx_23456789",
      botId: "bot-1",
      kind: "box" as const,
      providerRef: "bx_23456789",
    };
    const events: unknown[] = [];
    for await (const event of provider().execute(
      computer,
      { argv: ["bash", "-lc", "echo graphical-ok"], cwd: "/home/user" },
      ctx,
    )) {
      events.push(event);
    }
    expect(requests[0]?.body).toEqual({
      command: "cd /home/user && echo graphical-ok",
      timeoutSeconds: 300,
    });
    expect(events).toEqual([
      { type: "stdout", data: "graphical-ok\n" },
      { type: "exit", code: 0 },
    ]);
  });

  it("surfaces command failures as stderr plus non-zero exit", async () => {
    mockBoxApi(() => json({ ok: false, error: "box_starting" }, 409));
    const computer = {
      id: "bx_23456789",
      botId: "bot-1",
      kind: "box" as const,
      providerRef: "bx_23456789",
    };
    const events: Array<{ type: string; code?: number }> = [];
    for await (const event of provider().execute(computer, { argv: ["echo", "x"] }, ctx)) {
      events.push(event);
    }
    expect(events.at(-1)).toEqual({ type: "exit", code: 1 });
    expect(events.some((e) => e.type === "stderr")).toBe(true);
  });

  it("polls the desktop endpoint until the noVNC URL is ready", async () => {
    let calls = 0;
    mockBoxApi((req) => {
      if (req.method === "POST" && req.path === "/api/box/v1/boxes/bx_23456789/desktop?vnc=1") {
        calls += 1;
        if (calls === 1) return json({ ok: true, provisioning: true, message: "Preparing" });
        return json({
          ok: true,
          type: "desktop.url",
          success: true,
          desktopUrl: "https://box-preview.example/vnc.html?_token=abc",
          mode: "vnc",
        });
      }
      throw new Error(`unexpected request ${req.method} ${req.path}`);
    });
    const session = await provider().connectScreen(
      { id: "bx_23456789", botId: "bot-1", kind: "box", providerRef: "bx_23456789" },
      { view: "stream" },
      ctx,
    );
    expect(session.url).toBe("https://box-preview.example/vnc.html?_token=abc");
    expect(session.mimeType).toBe("text/html");
    await session.close();
  });

  it("stops by archiving and keeps state (no force)", async () => {
    const requests = mockBoxApi((req) => {
      if (req.method === "POST" && req.path === "/api/box/v1/boxes/bx_23456789/stop") {
        return json({ ok: true, type: "box.stopping", id: "bx_23456789" }, 202);
      }
      throw new Error(`unexpected request ${req.method} ${req.path}`);
    });
    await provider().stop(
      { id: "bx_23456789", botId: "bot-1", kind: "box", providerRef: "bx_23456789" },
      ctx,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toEqual({});
  });

  it("rejects when stop fails so callers do not mark a running box as stopped", async () => {
    mockBoxApi(() => json({ ok: false, error: "provider unavailable" }, 500));
    await expect(
      provider().stop(
        { id: "bx_23456789", botId: "bot-1", kind: "box", providerRef: "bx_23456789" },
        ctx,
      ),
    ).rejects.toThrow(/500/);
  });

  it("keepAlive resumes an archived box and leaves running boxes alone", async () => {
    let state = "archived";
    const requests = mockBoxApi((req) => {
      if (req.method === "GET") return json({ ok: true, box: boxInfo({ state }) });
      if (req.path.endsWith("/resume")) {
        state = "ready";
        return json({ ok: true, type: "box.resuming" }, 202);
      }
      throw new Error(`unexpected request ${req.method} ${req.path}`);
    });
    const computer = {
      id: "bx_23456789",
      botId: "bot-1",
      kind: "box" as const,
      providerRef: "bx_23456789",
    };
    const box = provider();
    await box.keepAlive(computer);
    expect(requests.some((r) => r.path.endsWith("/resume"))).toBe(true);
    const before = requests.length;
    await box.keepAlive(computer);
    expect(requests.slice(before).every((r) => r.method === "GET")).toBe(true);
  });

  it("maps the latest snapshot to a SnapshotRef", async () => {
    mockBoxApi((req) => {
      if (req.method === "GET" && req.path.endsWith("/snapshots/latest")) {
        return json({
          ok: true,
          type: "snapshot.latest",
          snapshot: {
            id: "7417be09-d419-4ae0-b3fc-7f04a5a71ef1",
            boxId: "bx_23456789",
            status: "completed",
            completedAt: "2026-06-24T06:24:50Z",
          },
        });
      }
      throw new Error(`unexpected request ${req.method} ${req.path}`);
    });
    const snap = await provider().snapshot(
      { id: "bx_23456789", botId: "bot-1", kind: "box", providerRef: "bx_23456789" },
      ctx,
    );
    expect(snap).toEqual({
      id: "7417be09-d419-4ae0-b3fc-7f04a5a71ef1",
      createdAt: "2026-06-24T06:24:50Z",
    });
  });

  it("sends the bearer key on every request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        expect(headers.authorization).toBe("Bearer box_test_key");
        return json({ ok: true, box: boxInfo() });
      }),
    );
    await provider().keepAlive({
      id: "bx_23456789",
      botId: "bot-1",
      kind: "box",
      providerRef: "bx_23456789",
    });
  });
});
