import type { AdapterContext } from "@quibt/adapter-kit";
import { describe, expect, it } from "vitest";
import type { QuibtCloudClient } from "./quibt-cloud-client.js";
import { QuibtCloudLimitError } from "./quibt-cloud-client.js";
import { QuibtCloudSandboxProvider } from "./quibt-cloud-sandbox.js";

function ctx(): AdapterContext {
  return {
    operationId: "op",
    traceId: "tr",
    workspaceId: "ws",
    userId: "user",
    signal: new AbortController().signal,
  };
}

function fakeClient(overrides: Partial<QuibtCloudClient> = {}): QuibtCloudClient {
  let token: string | null = "sess";
  return {
    baseUrl: "https://cloud.example.test",
    setToken: (value) => {
      token = value;
    },
    getToken: () => token,
    login: async () => ({ token: "sess" }),
    me: async () => ({
      plan: { id: "starter", name: "Starter" },
      hoursUsed: 1,
      hoursQuota: 10,
      concurrentComputers: 0,
      concurrentLimit: 1,
    }),
    listBoxes: async () => [{ id: "box-1", status: "stopped" }],
    resumeBox: async (id) => ({ id, status: "running" }),
    stopBox: async (id) => ({ id, status: "stopped" }),
    getConnection: async () => ({
      host: "box.example",
      port: 6080,
      credential: "tmp",
      screenUrl: "https://box.example/novnc/embed.html",
    }),
    ...overrides,
  };
}

describe("QuibtCloudSandboxProvider", () => {
  it("provisions by resuming an existing Cloud box and opens the remote screen", async () => {
    const resumed: string[] = [];
    const provider = new QuibtCloudSandboxProvider({
      client: fakeClient({
        resumeBox: async (id) => {
          resumed.push(id);
          return { id, status: "running" };
        },
      }),
    });
    const computer = await provider.provision(
      { botId: "bot-1", homePath: "/home/quibt" },
      ctx(),
    );
    expect(computer.kind).toBe("quibt-cloud");
    expect(computer.providerRef).toBe("box-1");
    expect(resumed).toEqual(["box-1"]);
    const screen = await provider.connectScreen(computer, { view: "stream" }, ctx());
    expect(screen.url).toBe("https://box.example/novnc/embed.html");
  });

  it("refuses to start when the session reports the hour cap", async () => {
    const provider = new QuibtCloudSandboxProvider({
      client: fakeClient({
        me: async () => ({
          plan: { id: "starter", name: "Starter" },
          hoursUsed: 10,
          hoursQuota: 10,
          concurrentComputers: 0,
          concurrentLimit: 1,
        }),
      }),
    });
    await expect(
      provider.provision({ botId: "bot-1", homePath: "/home/quibt" }, ctx()),
    ).rejects.toBeInstanceOf(QuibtCloudLimitError);
  });

  it("stops the box through the isolated client", async () => {
    const stopped: string[] = [];
    const provider = new QuibtCloudSandboxProvider({
      client: fakeClient({
        stopBox: async (id) => {
          stopped.push(id);
          return { id, status: "stopped" };
        },
      }),
    });
    await provider.stop(
      { id: "box-1", botId: "bot-1", kind: "quibt-cloud", providerRef: "box-1" },
      ctx(),
    );
    expect(stopped).toEqual(["box-1"]);
  });
});
