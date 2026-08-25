import { describe, expect, it } from "vitest";
import { machineActivationGate, splitMachineCatalog } from "./machine-settings.js";

describe("machineActivationGate", () => {
  it("blocks when credentials are missing", () => {
    expect(
      machineActivationGate({
        credentialsReady: false,
        credentialsMessage: "Cole a URL do supervisor da sua VPS.",
        probe: null,
      }),
    ).toEqual({
      ok: false,
      action: "blocked",
      message: "Cole a URL do supervisor da sua VPS.",
    });
  });

  it("requires probe before activate", () => {
    expect(
      machineActivationGate({
        credentialsReady: true,
        probe: null,
      }),
    ).toEqual({ ok: false, action: "probe", message: "Teste a máquina antes de salvar." });
  });

  it("activates only when probe is ok", () => {
    expect(
      machineActivationGate({
        credentialsReady: true,
        probe: { ok: true, message: "Docker respondeu." },
      }),
    ).toEqual({ ok: true, action: "activate" });
    expect(
      machineActivationGate({
        credentialsReady: true,
        probe: { ok: false, message: "Sem resposta do supervisor." },
      }),
    ).toEqual({ ok: false, action: "blocked", message: "Sem resposta do supervisor." });
  });
});

describe("splitMachineCatalog", () => {
  it("keeps VPS recipes in the catalog for hints", () => {
    const catalog = [
      { kind: "docker" },
      { kind: "remote-supervisor", family: "remote-supervisor" },
      { kind: "vps-hetzner", recipe: { hint: "Hetzner" } },
    ];
    const split = splitMachineCatalog(catalog);
    expect(split.cards.map((item) => item.kind)).toEqual(["docker", "remote-supervisor"]);
    expect(split.recipes.map((item) => item.kind)).toEqual(["vps-hetzner"]);
    expect(catalog).toHaveLength(3);
  });
});
