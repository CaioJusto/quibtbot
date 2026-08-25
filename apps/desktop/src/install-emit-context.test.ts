import { describe, expect, it } from "vitest";
import { InstallEmitContextRegistry } from "./install-emit-context.js";

describe("InstallEmitContextRegistry", () => {
  it("tracks emit context per operation id without clearing others", () => {
    const local = new InstallEmitContextRegistry();
    const remote = new InstallEmitContextRegistry();
    local.set("local-1", { senderId: 1, navigationId: 10 });
    remote.set("remote-1", { senderId: 2, navigationId: 20 });
    local.clear("local-1");
    expect(local.get("local-1")).toBeNull();
    expect(remote.get("remote-1")?.senderId).toBe(2);
  });
});
