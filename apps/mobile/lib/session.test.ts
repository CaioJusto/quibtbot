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
});

describe("mobile session storage", () => {
  it("reads the session token from SecureStore", async () => {
    getItemAsync.mockResolvedValueOnce("stored-token");
    const { loadSessionToken } = await import("./session");

    await expect(loadSessionToken()).resolves.toBe("stored-token");
    expect(getItemAsync).toHaveBeenCalledWith("quibt.session_token");
  });

  it("clears the session key on sign-out", async () => {
    const { clearSessionToken } = await import("./session");

    await clearSessionToken();
    expect(deleteItemAsync).toHaveBeenCalledWith("quibt.session_token");
  });

  it("saves a new session token", async () => {
    const { saveSessionToken } = await import("./session");

    await saveSessionToken("new-token");
    expect(setItemAsync).toHaveBeenCalledWith("quibt.session_token", "new-token");
  });

  it("serves the token from memory after the first read and forgets it on sign-out", async () => {
    const { clearSessionToken, loadSessionToken, saveSessionToken } = await import("./session");
    await saveSessionToken("cached-token");
    getItemAsync.mockClear();

    await expect(loadSessionToken()).resolves.toBe("cached-token");
    await expect(loadSessionToken()).resolves.toBe("cached-token");
    expect(getItemAsync).not.toHaveBeenCalled();

    await clearSessionToken();
    await expect(loadSessionToken()).resolves.toBe("");
    expect(getItemAsync).not.toHaveBeenCalled();
  });
});
