import { describe, expect, it } from "vitest";
import {
  nextStepAfterModel,
  onboardingSteps,
  resolveEdition,
  willCheckout,
} from "./onboarding-flow.js";

describe("resolveEdition", () => {
  it("obeys health over the billing snapshot", () => {
    expect(resolveEdition({ health: { edition: "oss" }, billing: { enabled: true } })).toBe("oss");
    expect(resolveEdition({ health: { edition: "cloud" }, billing: { enabled: false } })).toBe(
      "cloud",
    );
  });

  it("falls back to billing when health did not answer", () => {
    expect(resolveEdition({ health: null, billing: { enabled: true } })).toBe("cloud");
    expect(resolveEdition({})).toBe("oss");
    expect(resolveEdition({ health: { edition: "weird" } })).toBe("oss");
  });
});

describe("onboardingSteps", () => {
  it("OSS owner resolves to model, machine and bot", () => {
    expect(onboardingSteps("oss", { canChooseMachine: true, isOwner: true })).toEqual([
      "model",
      "machine",
      "bot",
    ]);
  });

  it("OSS non-owner skips machine", () => {
    expect(onboardingSteps("oss", { canChooseMachine: true, isOwner: false })).toEqual([
      "model",
      "bot",
    ]);
  });

  it("keeps plan then model on Cloud", () => {
    expect(onboardingSteps("cloud")).toEqual(["plan", "model", "bot"]);
  });
});

describe("nextStepAfterModel", () => {
  it("sends owners who can choose a machine to the machine step", () => {
    expect(nextStepAfterModel({ canChooseMachine: true, isOwner: true })).toBe("machine");
  });

  it("skips machine for non-owners", () => {
    expect(nextStepAfterModel({ canChooseMachine: true, isOwner: false })).toBe("bot");
  });
});

describe("willCheckout", () => {
  it("is false whenever billing is off, whatever plan came in the deep link", () => {
    expect(willCheckout("pro", { enabled: false })).toBe(false);
    expect(willCheckout("pro", null)).toBe(false);
  });

  it("is true only for a paid plan on a billing deploy", () => {
    expect(willCheckout("pro", { enabled: true })).toBe(true);
    expect(willCheckout("trial", { enabled: true })).toBe(false);
  });
});
