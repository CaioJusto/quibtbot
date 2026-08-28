import { beforeEach, describe, expect, it, vi } from "vitest";

const getItemAsync = vi.fn();
const setItemAsync = vi.fn();
const deleteItemAsync = vi.fn();

vi.mock("expo-secure-store", () => ({
  getItemAsync,
  setItemAsync,
  deleteItemAsync,
}));

beforeEach(() => {
  getItemAsync.mockReset();
  setItemAsync.mockReset();
  deleteItemAsync.mockReset();
  getItemAsync.mockResolvedValue(null);
  setItemAsync.mockResolvedValue(undefined);
  deleteItemAsync.mockResolvedValue(undefined);
});

describe("Box server id persistence", () => {
  it("persists and reloads a valid allocated Box id", async () => {
    const { loadBoxServerId, saveBoxServerId } = await import("./box-server-state.js");
    await saveBoxServerId("bx_23456789");
    expect(setItemAsync).toHaveBeenCalledWith("quibt.box.server-id", "bx_23456789");

    getItemAsync.mockResolvedValue("bx_23456789");
    await expect(loadBoxServerId()).resolves.toBe("bx_23456789");
  });

  it("does not persist or reload malformed ids", async () => {
    const { loadBoxServerId, saveBoxServerId } = await import("./box-server-state.js");
    await saveBoxServerId("not-a-box");
    expect(setItemAsync).not.toHaveBeenCalled();

    getItemAsync.mockResolvedValue("not-a-box");
    await expect(loadBoxServerId()).resolves.toBeNull();
  });
});
