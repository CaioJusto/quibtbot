import { describe, expect, it } from "vitest";
import { listMachineGuides, machineGuideFor } from "./machine-onboarding.js";

describe("machineGuideFor", () => {
  it("returns a full non-technical guide for every catalog kind", () => {
    for (const kind of [
      "docker",
      "remote-supervisor",
      "e2b",
      "box",
      "vps-hetzner",
      "vps-digitalocean",
      "vps-generic",
    ]) {
      const guide = machineGuideFor(kind);
      expect(guide.kind).toBe(kind);
      expect(guide.headline.length).toBeGreaterThan(10);
      expect(guide.what.length).toBeGreaterThan(40);
      expect(guide.youNeed.length).toBeGreaterThanOrEqual(2);
      expect(guide.steps.length).toBeGreaterThanOrEqual(3);
      expect(guide.botsShare.length).toBeGreaterThan(40);
      expect(guide.cost.length).toBeGreaterThan(10);
    }
  });

  it("maps unknown or empty kinds onto the Docker guide", () => {
    expect(machineGuideFor("").kind).toBe("docker");
    expect(machineGuideFor("desktop").kind).toBe("docker");
    expect(machineGuideFor(undefined).family).toBe("docker");
  });

  it("maps recipe kinds onto the remote-supervisor family", () => {
    expect(machineGuideFor("vps-hetzner").family).toBe("remote-supervisor");
    expect(machineGuideFor("vps-digitalocean").family).toBe("remote-supervisor");
    expect(machineGuideFor("vps-generic").family).toBe("remote-supervisor");
  });

  it("never describes a bot as a browser tab", () => {
    for (const guide of listMachineGuides()) {
      expect(guide.botsShare.toLowerCase()).not.toMatch(/cada bot (abre|ganha) uma aba/);
      expect(guide.botsShare).toMatch(/não é (uma )?aba|Não é aba|não emula/i);
    }
  });

  it("tells E2B and Box owners where to get a key", () => {
    expect(machineGuideFor("e2b").keyUrl).toMatch(/e2b\.dev/);
    expect(machineGuideFor("box").keyUrl).toMatch(/ascii\.dev|box\.ascii/);
    expect(machineGuideFor("docker").keyUrl).toBeUndefined();
  });

  it("says Docker bots share one computer and E2B/Box do not", () => {
    expect(machineGuideFor("docker").botsShare).toMatch(/mesmo computador/i);
    expect(machineGuideFor("e2b").botsShare).toMatch(/Não compartilham/);
    expect(machineGuideFor("box").botsShare).toMatch(/Não compartilham/);
  });

  it("spells out one graphical desktop per bot for Docker and the remote supervisor", () => {
    expect(machineGuideFor("docker").botsShare).toMatch(/desktop gráfico por bot/i);
    expect(machineGuideFor("remote-supervisor").botsShare).toMatch(/desktop gráfico por bot/i);
  });

  it("spells out one sandbox per bot for E2B and one VM per bot for Box", () => {
    expect(machineGuideFor("e2b").botsShare).toMatch(/um sandbox por bot/i);
    expect(machineGuideFor("box").botsShare).toMatch(/uma VM por bot/i);
  });

  it("never lets an E2B or Box guide claim it hosts the Quibt server, only the bot's computer", () => {
    for (const kind of ["e2b", "box"]) {
      const guide = machineGuideFor(kind);
      expect(`${guide.headline} ${guide.what}`).not.toMatch(
        /hospeda o servidor|é o servidor Quibt/i,
      );
    }
  });
});
