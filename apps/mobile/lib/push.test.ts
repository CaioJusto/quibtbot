import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getExpoPushTokenAsync: vi.fn(),
  setNotificationHandler: vi.fn(),
  setNotificationChannelAsync: vi.fn(),
}));

vi.mock("./api", () => ({ rpc: mocks.rpc, loadSessionToken: async () => "session-1" }));
vi.mock("expo-constants", () => ({ default: { easConfig: { projectId: "project-1" } } }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: mocks.getItemAsync,
  setItemAsync: mocks.setItemAsync,
  deleteItemAsync: mocks.deleteItemAsync,
}));
vi.mock("expo-notifications", () => ({
  AndroidImportance: { DEFAULT: 3 },
  getPermissionsAsync: mocks.getPermissionsAsync,
  requestPermissionsAsync: mocks.requestPermissionsAsync,
  getExpoPushTokenAsync: mocks.getExpoPushTokenAsync,
  setNotificationHandler: mocks.setNotificationHandler,
  setNotificationChannelAsync: mocks.setNotificationChannelAsync,
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.rpc.mockResolvedValue({ ok: true });
  mocks.setItemAsync.mockResolvedValue(undefined);
  mocks.deleteItemAsync.mockResolvedValue(undefined);
  mocks.setNotificationChannelAsync.mockResolvedValue(null);
  mocks.getPermissionsAsync.mockResolvedValue({ granted: true });
  mocks.getExpoPushTokenAsync.mockResolvedValue({ data: "ExpoPushToken[current-device]" });
  mocks.getItemAsync.mockResolvedValue(null);
});

describe("mobile push", () => {
  it("routes a notification to its bot thread and rejects malformed payloads", async () => {
    const { notificationTarget } = await import("./push");
    expect(notificationTarget({ botId: "bot-1", botName: "Pesquisa" })).toEqual({
      pathname: "/thread",
      params: { botId: "bot-1", name: "Pesquisa" },
    });
    expect(notificationTarget({ botId: "" })).toBeNull();
    expect(notificationTarget({ botId: 123 })).toBeNull();
  });

  it("registers the current token and removes a rotated token", async () => {
    mocks.getItemAsync.mockResolvedValue("ExpoPushToken[old-device]");
    const { registerPushToken } = await import("./push");
    await expect(registerPushToken()).resolves.toBe(true);
    expect(mocks.rpc.mock.calls).toEqual([
      ["notifications/registerPush", { token: "ExpoPushToken[current-device]" }],
      ["notifications/unregisterPush", { token: "ExpoPushToken[old-device]" }],
    ]);
    expect(mocks.setItemAsync).toHaveBeenCalledWith(
      "quibt.expo_push_token",
      "ExpoPushToken[current-device]",
    );
  });

  it("unregisters the stored device before clearing it locally", async () => {
    mocks.getItemAsync.mockResolvedValue("ExpoPushToken[current-device]");
    const { unregisterPushToken } = await import("./push");
    await unregisterPushToken();
    expect(mocks.rpc).toHaveBeenCalledWith("notifications/unregisterPush", {
      token: "ExpoPushToken[current-device]",
    });
    expect(mocks.deleteItemAsync).toHaveBeenCalledWith("quibt.expo_push_token");
  });
});
