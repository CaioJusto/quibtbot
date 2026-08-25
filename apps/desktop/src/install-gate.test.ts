import { describe, expect, it } from "vitest";
import { InstallConcurrencyGate } from "./install-gate.js";

describe("InstallConcurrencyGate", () => {
  it("shares one in-flight promise for the same operation id", async () => {
    const gate = new InstallConcurrencyGate<string>();
    let runs = 0;
    const work = async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "done";
    };

    const results = await Promise.all([gate.run("op-1", work), gate.run("op-1", work)]);
    expect(results).toEqual(["done", "done"]);
    expect(runs).toBe(1);
    expect(gate.busy).toBe(false);
  });

  it("rejects concurrent operations with different ids", async () => {
    const gate = new InstallConcurrencyGate<string>();
    const first = gate.run("op-1", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "first";
    });
    await expect(gate.run("op-2", async () => "second")).rejects.toThrow(/already in progress/i);
    await expect(first).resolves.toBe("first");
  });

  it("tracks active box state for cancel without clearing other operations", () => {
    const gate = new InstallConcurrencyGate<string>();
    gate.setActiveState({ kind: "box", apiKey: "box_key", boxId: "bx_23456789" });
    expect(gate.activeState()).toEqual({ kind: "box", apiKey: "box_key", boxId: "bx_23456789" });
  });

  it("cancels only the matching operation id", async () => {
    const gate = new InstallConcurrencyGate<string>();
    let aborted = false;
    const pending = gate.run("op-1", async (signal) => {
      await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
      return "never";
    });

    expect(gate.cancel("op-2")).toBe(false);
    expect(gate.cancel("op-1")).toBe(true);
    await expect(pending).rejects.toThrow(/aborted/i);
    expect(aborted).toBe(true);
  });
});
