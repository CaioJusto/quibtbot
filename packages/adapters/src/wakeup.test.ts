import { describe, expect, it } from "vitest";
import { InMemoryWakeupDriver } from "./wakeup.js";

function pendingTimers(driver: InMemoryWakeupDriver): unknown[] {
  return (driver as unknown as { timers: unknown[] }).timers;
}

describe("in-memory wakeup driver", () => {
  it("forgets a timer once its job ran", async () => {
    const driver = new InMemoryWakeupDriver();
    const seen: string[] = [];
    await driver.start({
      ping: async (payload) => {
        seen.push(String(payload.id));
      },
    });
    await driver.enqueue({ name: "ping", payload: { id: "a" } });
    await driver.enqueue({ name: "ping", payload: { id: "b" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual(["a", "b"]);
    // A self-rescheduling task (computer.sleep, run.reap) used to leak one entry per tick.
    expect(pendingTimers(driver)).toHaveLength(0);
    await driver.stop();
  });

  it("replaces a job that shares its key", async () => {
    const driver = new InMemoryWakeupDriver();
    const seen: string[] = [];
    await driver.start({
      ping: async (payload) => {
        seen.push(String(payload.id));
      },
    });
    await driver.enqueue({ name: "ping", payload: { id: "old" }, jobKey: "k" });
    await driver.enqueue({ name: "ping", payload: { id: "new" }, jobKey: "k" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual(["new"]);
    expect(pendingTimers(driver)).toHaveLength(0);
    await driver.stop();
  });

  it("waits for an in-flight job before shutdown completes", async () => {
    const driver = new InMemoryWakeupDriver();
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let completed = false;
    await driver.start({
      slow: async () => {
        await blocked;
        completed = true;
      },
    });
    await driver.enqueue({ name: "slow", payload: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));

    let stopped = false;
    const stopping = driver.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(completed).toBe(true);

    await driver.enqueue({ name: "slow", payload: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pendingTimers(driver)).toHaveLength(0);
  });
});
