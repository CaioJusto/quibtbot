import { describe, expect, it } from "vitest";
import {
  bootableKind,
  filterCatalog,
  isPrimaryMachine,
  listPickableMachines,
  MACHINE_CATALOG,
  machineIsReady,
  searchMachineCatalog,
} from "./computer-catalog.js";
import { machineGuideFor } from "./machine-onboarding.js";

describe("computer catalog", () => {
  it("lists the bootable OSS machines and the VPS recipes", () => {
    expect(listPickableMachines()).toEqual([
      "docker",
      "remote-supervisor",
      "e2b",
      "box",
      "daytona",
    ]);
    expect(searchMachineCatalog("").map((entry) => entry.kind)).toContain("vps-hetzner");
    expect(isPrimaryMachine("docker")).toBe(true);
    expect(isPrimaryMachine("e2b")).toBe(true);
    expect(isPrimaryMachine("box")).toBe(true);
    expect(isPrimaryMachine("daytona")).toBe(true);
    expect(isPrimaryMachine("remote-supervisor")).toBe(true);
    expect(isPrimaryMachine("vps-hetzner")).toBe(false);
  });

  it("maps recipe kinds onto remote-supervisor", () => {
    expect(bootableKind("vps-hetzner")).toBe("remote-supervisor");
    expect(bootableKind("docker")).toBe("docker");
    expect(bootableKind("desktop")).toBeNull();
  });

  it("searches titles and aliases", () => {
    expect(searchMachineCatalog("hetzner").map((entry) => entry.kind)).toEqual(["vps-hetzner"]);
    expect(searchMachineCatalog("mercado").length).toBeGreaterThan(1);
  });

  it("has a plain-language onboarding guide for every catalog card", () => {
    for (const entry of MACHINE_CATALOG) {
      expect(machineGuideFor(entry.kind).kind).toBe(entry.kind);
    }
  });

  it("never promises a bare supervisor port the Compose does not publish", () => {
    // A 7091 não é publicada por profile nenhum (infra/compose/docker-compose.desktop.yml).
    // Com o profile `supervisor-tls` quem atende é o Caddy, em 443, pelo nome público — então
    // um rótulo que manda colar `https://vps:7091` ensina um endereço que não existe.
    for (const entry of MACHINE_CATALOG) {
      const text = [entry.title, entry.body, entry.endpointLabel, entry.recipe?.hint]
        .filter(Boolean)
        .join("\n");
      expect(text, `${entry.kind} points at the unpublished port`).not.toMatch(
        /https?:\/\/[^\s"']*:7091/,
      );
    }
    const remote = MACHINE_CATALOG.find((entry) => entry.kind === "remote-supervisor");
    expect(remote?.endpointLabel).toMatch(/https/i);
    expect(remote?.endpointLabel).toMatch(/supervisor-tls/);
  });

  it("marks readiness from keys and endpoints, not from the recipe id", () => {
    expect(machineIsReady("e2b", {})).toBe(false);
    expect(machineIsReady("e2b", { e2bApiKey: "key" })).toBe(true);
    expect(machineIsReady("daytona", {})).toBe(false);
    expect(machineIsReady("daytona", { daytonaApiKey: "key" })).toBe(true);
    expect(
      machineIsReady("vps-generic", {
        remoteSupervisorUrl: "https://vps:7091",
        remoteSupervisorToken: "tok",
      }),
    ).toBe(true);
    const catalog = filterCatalog("docker", { dockerReady: true });
    expect(catalog[0]?.ready).toBe(true);
  });
});
