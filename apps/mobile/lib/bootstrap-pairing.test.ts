import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getItemAsync = vi.fn();
const setItemAsync = vi.fn();
const deleteItemAsync = vi.fn();
const saveApiBase = vi.fn();
const saveSessionToken = vi.fn();

vi.mock("expo-secure-store", () => ({
  getItemAsync,
  setItemAsync,
  deleteItemAsync,
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return {
    ...actual,
    saveApiBase,
  };
});

vi.mock("./session", () => ({
  clearSessionToken: vi.fn(),
  loadSessionToken: vi.fn(),
  saveSessionToken,
  tokenFromAuthResponse: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  getItemAsync.mockReset();
  setItemAsync.mockReset();
  deleteItemAsync.mockReset();
  saveApiBase.mockReset();
  saveSessionToken.mockReset();
  saveApiBase.mockResolvedValue({ ok: true, url: "https://quibt.example.com" });
  setItemAsync.mockResolvedValue(undefined);
  deleteItemAsync.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeInstallationCode", () => {
  it("normalizes ambiguous Crockford characters before claim", async () => {
    const { normalizeInstallationCode } = await import("./bootstrap-pairing.js");
    expect(normalizeInstallationCode("  oi1l2345  ")).toBe("01112345");
  });
});

describe("parseBootstrapDeepLink", () => {
  it("reads api and enrollment token from quibt://bootstrap links", async () => {
    const { parseBootstrapDeepLink } = await import("./bootstrap-pairing.js");
    expect(
      parseBootstrapDeepLink(
        "quibt://bootstrap?api=https%3A%2F%2Fquibt.example.com&token=enroll-token",
      ),
    ).toEqual({
      api: "https://quibt.example.com",
      token: "enroll-token",
    });
  });

  it("ignores authenticated connect links", async () => {
    const { parseBootstrapDeepLink } = await import("./bootstrap-pairing.js");
    expect(
      parseBootstrapDeepLink("quibt://connect?api=https://quibt.example.com&pair=session-token"),
    ).toBeNull();
  });
});

describe("claimInstallation", () => {
  it("normalizes the server URL, claims the code, and stores enrollment separately from session", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        enrollmentToken: "enroll-abc",
        expiresAt: "2026-08-17T12:00:00.000Z",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { claimInstallation } = await import("./bootstrap-pairing.js");

    const result = await claimInstallation("https://quibt.example.com/", "oi1l2345");

    expect(result).toEqual({ ok: true, redirectTo: "/sign-up" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://quibt.example.com/api/bootstrap/claim",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ code: "01112345" }),
      }),
    );
    expect(saveApiBase).toHaveBeenCalledWith("https://quibt.example.com");
    expect(setItemAsync).toHaveBeenCalledWith("quibt.bootstrap_enrollment", "enroll-abc");
    expect(saveSessionToken).not.toHaveBeenCalled();
  });

  it("surfaces expired or replayed codes without creating a session", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ message: "Código expirado ou já usado." }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { claimInstallation } = await import("./bootstrap-pairing.js");

    const result = await claimInstallation("https://quibt.example.com", "ABCD1234");

    expect(result).toEqual({
      ok: false,
      error: "Código expirado ou já usado.",
      terminal: true,
    });
    expect(setItemAsync).not.toHaveBeenCalled();
    expect(saveSessionToken).not.toHaveBeenCalled();
  });
});

describe("confirmBootstrapLink", () => {
  it("exchanges the confirmed QR invite and stores enrollment without granting a session", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ enrollmentToken: "enroll-qr" }),
    });
    const { confirmBootstrapLink } = await import("./bootstrap-pairing.js");

    const result = await confirmBootstrapLink(
      "quibt://bootstrap?api=https%3A%2F%2Fquibt.example.com&token=enroll-qr",
      fetchMock,
    );

    expect(result).toEqual({ ok: true, redirectTo: "/sign-up" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://quibt.example.com/api/bootstrap/claim",
      expect.objectContaining({ body: JSON.stringify({ token: "enroll-qr" }) }),
    );
    expect(saveApiBase).toHaveBeenCalledWith("https://quibt.example.com");
    expect(setItemAsync).toHaveBeenCalledWith("quibt.bootstrap_enrollment", "enroll-qr");
    expect(saveSessionToken).not.toHaveBeenCalled();
  });

  it("returns not-bootstrap for connect links so scan can fall back", async () => {
    const { confirmBootstrapLink } = await import("./bootstrap-pairing.js");

    const result = await confirmBootstrapLink(
      "quibt://connect?api=https://quibt.example.com&pair=one-time",
    );

    expect(result).toEqual({ ok: false, notBootstrap: true, error: "" });
    expect(saveApiBase).not.toHaveBeenCalled();
  });
});

describe("enrollment lifecycle", () => {
  it("clears enrollment from SecureStore", async () => {
    const { clearEnrollmentToken } = await import("./bootstrap-pairing.js");

    await clearEnrollmentToken();
    expect(deleteItemAsync).toHaveBeenCalledWith("quibt.bootstrap_enrollment");
  });
});
