import { QUIBT_CLOUD_API_URL_PLACEHOLDER, quibtCloudUpgradeMessage } from "@quibt/core";
import { describe, expect, it } from "vitest";
import {
  createQuibtCloudClient,
  isQuibtCloudLimitError,
  parseQuibtCloudMe,
  QuibtCloudLimitError,
  QuibtCloudSession,
  readSessionToken,
} from "./quibt-cloud-client.js";

type Handler = (req: { method: string; path: string; body: unknown; auth: string | null }) => {
  status: number;
  body: unknown;
};

function mockFetch(handler: Handler): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    let parsed: unknown;
    if (typeof init?.body === "string" && init.body) {
      parsed = JSON.parse(init.body);
    }
    const result = handler({
      method: (init?.method ?? "GET").toUpperCase(),
      path: url.pathname,
      body: parsed,
      auth: new Headers(init?.headers).get("authorization"),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("QuibtCloudHttpClient hypothesized contract", () => {
  it("logs in, stores the session token, and reads plan usage", async () => {
    const calls: string[] = [];
    const fetchImpl = mockFetch((req) => {
      calls.push(`${req.method} ${req.path}`);
      if (req.method === "POST" && req.path === "/api/auth/login") {
        expect(req.body).toEqual({ email: "ada@example.com", password: "secret" });
        expect(req.auth).toBeNull();
        return { status: 200, body: { token: "sess-1" } };
      }
      if (req.path === "/api/me") {
        expect(req.auth).toBe("Bearer sess-1");
        return {
          status: 200,
          body: {
            email: "ada@example.com",
            plan: { id: "pro", name: "Pro" },
            hoursUsed: 3.5,
            hoursQuota: 40,
            concurrentComputers: 1,
            concurrentLimit: 2,
          },
        };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });

    const client = createQuibtCloudClient({
      baseUrl: "https://cloud.example.test",
      fetchImpl,
    });
    const login = await client.login("ada@example.com", "secret");
    expect(login.token).toBe("sess-1");
    expect(client.getToken()).toBe("sess-1");
    const me = await client.me();
    expect(me.plan.name).toBe("Pro");
    expect(me.hoursUsed).toBe(3.5);
    expect(me.hoursQuota).toBe(40);
    expect(calls).toEqual(["POST /api/auth/login", "GET /api/me"]);
  });

  it("lists boxes and resumes / stops / reads a connection", async () => {
    const fetchImpl = mockFetch((req) => {
      if (req.path === "/api/boxes" && req.method === "GET") {
        return {
          status: 200,
          body: {
            boxes: [
              { id: "box-a", status: "stopped" },
              { id: "box-b", state: "running" },
            ],
          },
        };
      }
      if (req.path === "/api/boxes/box-a/resume") {
        return { status: 200, body: { box: { id: "box-a", status: "running" } } };
      }
      if (req.path === "/api/boxes/box-a/stop") {
        return { status: 200, body: { id: "box-a", status: "stopped" } };
      }
      if (req.path === "/api/boxes/box-a/connection") {
        return {
          status: 200,
          body: {
            host: "box.example",
            port: 6080,
            credential: "tmp",
            protocol: "novnc",
          },
        };
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });

    const client = createQuibtCloudClient({
      baseUrl: "https://cloud.example.test",
      token: "sess-1",
      fetchImpl,
    });
    expect(await client.listBoxes()).toEqual([
      { id: "box-a", status: "stopped" },
      { id: "box-b", status: "running" },
    ]);
    expect(await client.resumeBox("box-a")).toEqual({ id: "box-a", status: "running" });
    expect(await client.stopBox("box-a")).toEqual({ id: "box-a", status: "stopped" });
    expect(await client.getConnection("box-a")).toMatchObject({
      host: "box.example",
      port: 6080,
      credential: "tmp",
      protocol: "novnc",
    });
  });

  it("defaults to the marked placeholder URL", () => {
    const client = createQuibtCloudClient();
    expect(client.baseUrl).toBe(QUIBT_CLOUD_API_URL_PLACEHOLDER);
  });

  it("calls globalThis.fetch without Illegal invocation (browser-style binding)", async () => {
    const original = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = mockFetch((req) => {
      calls.push(`${req.method} ${req.path}`);
      return { status: 200, body: { token: "sess-bind" } };
    });
    try {
      const client = createQuibtCloudClient({ baseUrl: QUIBT_CLOUD_API_URL_PLACEHOLDER });
      await expect(client.login("a@b.c", "x")).resolves.toEqual({ token: "sess-bind" });
      expect(calls).toEqual(["POST /api/auth/login"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("maps a hours-exhausted resume to a limit error", async () => {
    const fetchImpl = mockFetch((req) => {
      if (req.path.endsWith("/resume")) {
        return { status: 402, body: { code: "hours_exhausted" } };
      }
      return { status: 500, body: {} };
    });
    const client = createQuibtCloudClient({ token: "sess", fetchImpl });
    await expect(client.resumeBox("box-a")).rejects.toBeInstanceOf(QuibtCloudLimitError);
    try {
      await client.resumeBox("box-a");
    } catch (error) {
      expect(isQuibtCloudLimitError(error)).toBe(true);
      if (isQuibtCloudLimitError(error)) {
        expect(error.limit.kind).toBe("hours");
        expect(error.message).toBe(quibtCloudUpgradeMessage("hours"));
      }
    }
  });

  it("accepts alternate hypothesized field names on /api/me and login", () => {
    expect(
      parseQuibtCloudMe({
        account: {
          email: "ada@example.com",
          currentPlan: "pro",
          hours_used: "8",
          hours_quota: 20,
          runningBoxes: 1,
          maxComputers: 3,
        },
      }),
    ).toEqual({
      email: "ada@example.com",
      plan: { id: "pro", name: "pro" },
      hoursUsed: 8,
      hoursQuota: 20,
      concurrentComputers: 1,
      concurrentLimit: 3,
    });
    expect(readSessionToken({ session: { accessToken: "tok" } })).toBe("tok");
  });
});

describe("QuibtCloudSession", () => {
  it("logs in and reflects usage against the plan cap", async () => {
    const fetchImpl = mockFetch((req) => {
      if (req.path === "/api/auth/login") return { status: 200, body: { token: "sess-9" } };
      if (req.path === "/api/me") {
        return {
          status: 200,
          body: {
            plan: { id: "starter", name: "Starter" },
            hoursUsed: 2,
            hoursQuota: 10,
            concurrentComputers: 0,
            concurrentLimit: 1,
          },
        };
      }
      if (req.path === "/api/boxes") {
        return { status: 200, body: { boxes: [{ id: "box-1", status: "stopped" }] } };
      }
      throw new Error(req.path);
    });
    const session = new QuibtCloudSession(
      createQuibtCloudClient({ fetchImpl, baseUrl: "https://cloud.example.test" }),
    );
    const snap = await session.login("ada@example.com", "pw");
    expect(snap.token).toBe("sess-9");
    expect(snap.me?.hoursUsed).toBe(2);
    expect(snap.me?.hoursQuota).toBe(10);
    expect(snap.boxes).toEqual([{ id: "box-1", status: "stopped" }]);
    expect(snap.limit).toBeNull();
  });

  it("blocks resume locally when the hour cap is already reached", async () => {
    let resumed = false;
    const fetchImpl = mockFetch((req) => {
      if (req.path === "/api/me") {
        return {
          status: 200,
          body: {
            plan: { id: "starter", name: "Starter" },
            hoursUsed: 10,
            hoursQuota: 10,
            concurrentComputers: 0,
            concurrentLimit: 1,
          },
        };
      }
      if (req.path === "/api/boxes") return { status: 200, body: { boxes: [] } };
      if (req.path.endsWith("/resume")) {
        resumed = true;
        return { status: 200, body: { id: "box-1", status: "running" } };
      }
      throw new Error(req.path);
    });
    const session = new QuibtCloudSession(
      createQuibtCloudClient({ fetchImpl, token: "sess", baseUrl: "https://cloud.example.test" }),
    );
    await session.refresh();
    await expect(session.resume("box-1")).rejects.toBeInstanceOf(QuibtCloudLimitError);
    expect(resumed).toBe(false);
  });

  it("blocks a new start at the concurrent cap but still allows stop", async () => {
    const fetchImpl = mockFetch((req) => {
      if (req.path === "/api/me") {
        return {
          status: 200,
          body: {
            plan: { id: "starter", name: "Starter" },
            hoursUsed: 1,
            hoursQuota: 10,
            concurrentComputers: 1,
            concurrentLimit: 1,
          },
        };
      }
      if (req.path === "/api/boxes") {
        return {
          status: 200,
          body: {
            boxes: [
              { id: "box-1", status: "running" },
              { id: "box-2", status: "stopped" },
            ],
          },
        };
      }
      if (req.path === "/api/boxes/box-1/stop") {
        return { status: 200, body: { id: "box-1", status: "stopped" } };
      }
      if (req.path.endsWith("/resume")) {
        throw new Error("resume must not be called");
      }
      throw new Error(req.path);
    });
    const session = new QuibtCloudSession(
      createQuibtCloudClient({ fetchImpl, token: "sess", baseUrl: "https://cloud.example.test" }),
    );
    const snap = await session.refresh();
    expect(snap.limit?.kind).toBe("concurrent");
    await expect(session.resume("box-2")).rejects.toMatchObject({
      limit: { kind: "concurrent" },
    });
    const afterStop = await session.stop("box-1");
    expect(afterStop.boxes.find((box) => box.id === "box-1")?.status).toBe("stopped");
  });
});
