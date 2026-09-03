import { describe, expect, it } from "vitest";
import {
  allowsSharedDocker,
  assertEditionConfig,
  assertEditionMachine,
  availableOssMachines,
  editionGate,
  machineFamily,
  parseOssMachine,
  resolveDeploymentMachine,
  resolveEdition,
} from "./edition.js";

describe("resolveEdition", () => {
  it("defaults to oss when billing is off", () => {
    expect(resolveEdition({ billingEnabled: false })).toBe("oss");
  });

  it("defaults to cloud when billing is on", () => {
    expect(resolveEdition({ billingEnabled: true })).toBe("cloud");
  });

  it("honors an explicit edition string", () => {
    expect(resolveEdition({ edition: "open-source", billingEnabled: false })).toBe("oss");
    expect(resolveEdition({ edition: "CLOUD", billingEnabled: true })).toBe("cloud");
  });
});

describe("editionGate", () => {
  it("hands the machine picker only to an unpaid self-host deploy", () => {
    expect(editionGate({ edition: "oss", billingEnabled: false })).toEqual({
      edition: "oss",
      billingEnabled: false,
      canChooseMachine: true,
    });
    expect(editionGate({})).toEqual({
      edition: "oss",
      billingEnabled: false,
      canChooseMachine: true,
    });
  });

  it("fails closed when the edition flag is missing on a billing deploy", () => {
    expect(editionGate({ billingEnabled: true })).toEqual({
      edition: "cloud",
      billingEnabled: true,
      canChooseMachine: false,
    });
    // Even a deploy that mislabels itself oss while charging cards keeps the picker shut.
    expect(editionGate({ edition: "oss", billingEnabled: true }).canChooseMachine).toBe(false);
  });
});

describe("assertEditionConfig", () => {
  it("rejects cloud without billing and oss with billing", () => {
    expect(() => assertEditionConfig("cloud", false)).toThrow(/BILLING_ENABLED/);
    expect(() => assertEditionConfig("oss", true)).toThrow(/cannot run/);
    expect(() => assertEditionConfig("oss", false)).not.toThrow();
    expect(() => assertEditionConfig("cloud", true)).not.toThrow();
  });
});

describe("assertEditionMachine", () => {
  it("refuses Cloud on the shared Docker host and accepts the isolating machines", () => {
    expect(() => assertEditionMachine({ edition: "cloud", sandboxProvider: "docker" })).toThrow(
      /share one host kernel/,
    );
    expect(() =>
      assertEditionMachine({ edition: "cloud", sandboxProvider: "docker", nodeEnv: "production" }),
    ).toThrow(/QUIBT_ALLOW_SHARED_DOCKER/);
    expect(() =>
      assertEditionMachine({ edition: "cloud", sandboxProvider: "e2b", nodeEnv: "production" }),
    ).not.toThrow();
    expect(() =>
      assertEditionMachine({ edition: "cloud", sandboxProvider: "box", nodeEnv: "production" }),
    ).not.toThrow();
    expect(() =>
      assertEditionMachine({ edition: "cloud", sandboxProvider: "daytona", nodeEnv: "production" }),
    ).not.toThrow();
  });

  it("never blocks the self-host case Docker exists for", () => {
    expect(() =>
      assertEditionMachine({ edition: "oss", sandboxProvider: "docker", nodeEnv: "production" }),
    ).not.toThrow();
  });

  it("keeps emulators legal off production and honors the loud opt-out", () => {
    expect(() => assertEditionMachine({ edition: "cloud", sandboxProvider: "fake" })).not.toThrow();
    expect(() =>
      assertEditionMachine({ edition: "cloud", sandboxProvider: "fake", nodeEnv: "production" }),
    ).toThrow(/cannot run/);
    expect(() =>
      assertEditionMachine({
        edition: "cloud",
        sandboxProvider: "docker",
        nodeEnv: "production",
        allowSharedDocker: true,
      }),
    ).not.toThrow();
  });
});

describe("allowsSharedDocker", () => {
  it("only accepts an explicit opt-in", () => {
    expect(allowsSharedDocker({})).toBe(false);
    expect(allowsSharedDocker({ QUIBT_ALLOW_SHARED_DOCKER: "false" })).toBe(false);
    expect(allowsSharedDocker({ QUIBT_ALLOW_SHARED_DOCKER: "true" })).toBe(true);
    expect(allowsSharedDocker({ QUIBT_ALLOW_SHARED_DOCKER: "1" })).toBe(true);
  });
});

describe("availableOssMachines", () => {
  it("always offers docker and unlocks remotes when keys exist", () => {
    expect(availableOssMachines({})).toEqual(["docker"]);
    expect(
      availableOssMachines({
        e2bApiKey: "e2b",
        boxApiKey: "box",
        daytonaApiKey: "daytona",
      }),
    ).toEqual(["docker", "e2b", "box", "daytona"]);
  });
});

describe("resolveDeploymentMachine", () => {
  it("puts the saved choice in force instead of the process env", () => {
    expect(
      resolveDeploymentMachine({
        saved: "e2b",
        envProvider: "docker",
        canChooseMachine: true,
        available: ["docker", "e2b"],
      }),
    ).toEqual({ machine: "e2b", source: "deployment" });
  });

  it("falls back to the env when nothing is saved, the edition forbids it, or the key is gone", () => {
    expect(
      resolveDeploymentMachine({ saved: null, envProvider: "docker", canChooseMachine: true }),
    ).toEqual({ machine: "docker", source: "env" });
    expect(
      resolveDeploymentMachine({ saved: "e2b", envProvider: "box", canChooseMachine: false }),
    ).toEqual({ machine: "box", source: "env" });
    expect(
      resolveDeploymentMachine({
        saved: "e2b",
        envProvider: "docker",
        canChooseMachine: true,
        available: ["docker"],
      }),
    ).toEqual({ machine: "docker", source: "env" });
  });

  it("reports the emulators as the family they stand in for", () => {
    expect(machineFamily("e2b-emulator")).toBe("e2b");
    expect(machineFamily("box-emulator")).toBe("box");
    expect(machineFamily("daytona-emulator")).toBe("daytona");
    expect(machineFamily("fake")).toBeNull();
    expect(
      resolveDeploymentMachine({ envProvider: "fake", canChooseMachine: true }).machine,
    ).toBeNull();
  });
});

describe("parseOssMachine", () => {
  it("accepts the self-host computer providers", () => {
    expect(parseOssMachine("docker")).toBe("docker");
    expect(parseOssMachine("E2B")).toBe("e2b");
    expect(parseOssMachine("remote-supervisor")).toBe("remote-supervisor");
    expect(parseOssMachine("DAYTONA")).toBe("daytona");
    expect(parseOssMachine("quibt-cloud")).toBe("quibt-cloud");
    expect(parseOssMachine("desktop")).toBeNull();
  });
});
