import { describe, expect, it } from "vitest";
import { pollForConnection } from "./connection-poll.js";

const noWait = () => Promise.resolve();

describe("pollForConnection", () => {
  it("stops as soon as the connection lands", async () => {
    let calls = 0;
    const result = await pollForConnection({
      attempts: 5,
      delayMs: 0,
      wait: noWait,
      check: async () => {
        calls += 1;
        return calls === 2 ? { status: "connected" } : { status: "pending" };
      },
    });
    expect(result).toBe("connected");
    expect(calls).toBe(2);
  });

  it("stops calling the API once the caller cancels", async () => {
    let calls = 0;
    let open = true;
    const result = await pollForConnection({
      attempts: 45,
      delayMs: 0,
      wait: noWait,
      cancelled: () => !open,
      check: async () => {
        calls += 1;
        open = false;
        return { status: "pending" };
      },
    });
    expect(result).toBe("cancelled");
    expect(calls).toBe(1);
  });

  it("gives up after the last attempt", async () => {
    let calls = 0;
    const result = await pollForConnection({
      attempts: 3,
      delayMs: 0,
      wait: noWait,
      check: async () => {
        calls += 1;
        return { status: "pending" };
      },
    });
    expect(result).toBe("timeout");
    expect(calls).toBe(3);
  });

  it("keeps waiting when a single check fails", async () => {
    let calls = 0;
    const result = await pollForConnection({
      attempts: 3,
      delayMs: 0,
      wait: noWait,
      check: async () => {
        calls += 1;
        if (calls === 1) throw new Error("network");
        return { status: "connected" };
      },
    });
    expect(result).toBe("connected");
    expect(calls).toBe(2);
  });
});
