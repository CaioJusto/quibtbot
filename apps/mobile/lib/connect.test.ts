import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  claimPairToken: vi.fn(),
  probeApiBase: vi.fn(),
  saveApiBase: vi.fn(),
}));

vi.mock("./api", () => api);

describe("applyConnectLink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails closed without changing servers when the endpoint probe fails", async () => {
    api.probeApiBase.mockResolvedValue({
      ok: false,
      error: "Não foi possível alcançar esse servidor",
    });
    const { applyConnectLink } = await import("./connect");

    await expect(
      applyConnectLink("quibt://connect?api=https%3A%2F%2Foffline.example&pair=one-time-secret"),
    ).resolves.toEqual({
      ok: false,
      reason: "unreachable",
      api: "https://offline.example",
    });
    expect(api.saveApiBase).not.toHaveBeenCalled();
    expect(api.claimPairToken).not.toHaveBeenCalled();
  });

  it("saves only the probed origin before exchanging its pairing token", async () => {
    api.probeApiBase.mockResolvedValue({
      ok: true,
      url: "https://quibt.example",
    });
    api.saveApiBase.mockResolvedValue({
      ok: true,
      url: "https://quibt.example",
    });
    api.claimPairToken.mockResolvedValue({ name: "Ada" });
    const { applyConnectLink } = await import("./connect");

    await expect(
      applyConnectLink(
        "quibt://connect?api=https%3A%2F%2Fquibt.example%2Fignored&pair=one-time-secret",
      ),
    ).resolves.toEqual({
      ok: true,
      api: "https://quibt.example",
      signedIn: true,
      name: "Ada",
    });
    expect(api.saveApiBase).toHaveBeenCalledWith("https://quibt.example");
    expect(api.claimPairToken).toHaveBeenCalledWith("one-time-secret");
  });
});

describe("connectFailureMessage", () => {
  it("blames the QR only when it really is not ours", async () => {
    const { connectFailureMessage } = await import("./connect");
    expect(connectFailureMessage({ ok: false, reason: "not-quibt" })).toContain(
      "não é de um computador Quibt",
    );
  });

  it("explains loopback instead of calling a valid QR fake", async () => {
    const { connectFailureMessage } = await import("./connect");
    // Era este o caso que dizia "esse QR não é do Quibt" para um QR perfeitamente válido.
    const message = connectFailureMessage({
      ok: false,
      reason: "loopback",
      api: "http://127.0.0.1:3100",
    });
    expect(message).toContain("127.0.0.1:3100");
    expect(message).toContain("app do computador");
    expect(message).not.toContain("não é de um computador Quibt");
  });

  it("names the host it could not reach", async () => {
    const { connectFailureMessage } = await import("./connect");
    const message = connectFailureMessage({
      ok: false,
      reason: "unreachable",
      api: "http://192.168.1.20:3100",
    });
    expect(message).toContain("192.168.1.20:3100");
    expect(message).toContain("mesma rede");
  });

  it("points iPhone users to the local-network permission after a LAN failure", async () => {
    const { connectFailureMessage } = await import("./connect");
    const message = connectFailureMessage(
      { ok: false, reason: "unreachable", api: "http://192.168.1.20:3100" },
      "ios",
    );
    expect(message).toContain("Ajustes");
    expect(message).toContain("Rede Local");
  });
});
