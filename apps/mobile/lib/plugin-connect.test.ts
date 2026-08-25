import { describe, expect, it, vi } from "vitest";
import {
  connectionIdFromCallbackUrl,
  NATIVE_PLUGIN_CALLBACK,
  openPluginAuthorization,
  pluginCallbackUrl,
  waitForPluginConnection,
} from "./plugin-connect";

describe("pluginCallbackUrl", () => {
  it("prefers the native scheme over the web bounce", () => {
    expect(pluginCallbackUrl()).toBe(NATIVE_PLUGIN_CALLBACK);
    expect(pluginCallbackUrl()).not.toContain("http");
  });

  it("keeps Expo Go's exp:// URL so the session can return in development", () => {
    expect(pluginCallbackUrl(() => "exp://192.168.1.20:8081/--/plugins/callback")).toBe(
      "exp://192.168.1.20:8081/--/plugins/callback",
    );
  });

  it("ignores an http createURL result instead of sending OAuth to a random page", () => {
    expect(pluginCallbackUrl(() => "https://evil.test/steal")).toBe(NATIVE_PLUGIN_CALLBACK);
  });
});

describe("connectionIdFromCallbackUrl", () => {
  it("reads the row id the API put on the deep link", () => {
    expect(connectionIdFromCallbackUrl("quibt://plugins/callback?connectionId=conn_9")).toBe(
      "conn_9",
    );
    expect(connectionIdFromCallbackUrl("not-a-url")).toBeNull();
  });
});

describe("waitForPluginConnection", () => {
  it("polls until connected and stops when the screen goes away", async () => {
    const noWait = () => Promise.resolve();
    let calls = 0;
    let alive = true;
    const result = await waitForPluginConnection({
      connectionId: "conn_1",
      hasAuthorizationUrl: true,
      cancelled: () => !alive,
      wait: noWait,
      complete: async () => {
        calls += 1;
        if (calls === 1) return { status: "pending" };
        return { status: "connected" };
      },
    });
    expect(result).toBe("connected");
    expect(calls).toBe(2);

    calls = 0;
    alive = true;
    const cancelled = await waitForPluginConnection({
      connectionId: "conn_1",
      hasAuthorizationUrl: true,
      cancelled: () => !alive,
      complete: async () => {
        calls += 1;
        alive = false;
        return { status: "pending" };
      },
    });
    expect(cancelled).toBe("cancelled");
    expect(calls).toBe(1);
  });

  it("checks once when there is no browser login", async () => {
    const complete = vi.fn(async () => ({ status: "connected" as const }));
    await expect(
      waitForPluginConnection({
        connectionId: "conn_1",
        hasAuthorizationUrl: false,
        cancelled: () => false,
        complete,
      }),
    ).resolves.toBe("connected");
    expect(complete).toHaveBeenCalledOnce();
  });
});

describe("openPluginAuthorization", () => {
  it("uses the in-app auth session and returns the deep link", async () => {
    const openUrl = vi.fn();
    const url = await openPluginAuthorization({
      authorizationUrl: "https://auth.example/start",
      redirectUrl: NATIVE_PLUGIN_CALLBACK,
      openAuthSession: async () => ({
        type: "success",
        url: "quibt://plugins/callback?connectionId=conn_1",
      }),
      openUrl,
    });
    expect(url).toBe("quibt://plugins/callback?connectionId=conn_1");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("falls back to opening the system browser when the session API is missing", async () => {
    const openUrl = vi.fn().mockResolvedValue(undefined);
    const url = await openPluginAuthorization({
      authorizationUrl: "https://auth.example/start",
      redirectUrl: NATIVE_PLUGIN_CALLBACK,
      openUrl,
    });
    expect(url).toBeNull();
    expect(openUrl).toHaveBeenCalledWith("https://auth.example/start");
  });
});
