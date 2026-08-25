import { describe, expect, it } from "vitest";
import { SshInspectionStore } from "./ssh-inspection-store.js";

describe("SshInspectionStore", () => {
  it("stores inspect results and consumes them once", () => {
    const store = new SshInspectionStore(60_000);
    const created = store.create({
      hostname: "vps.example",
      ip: "203.0.113.10",
      port: 22,
      username: "root",
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:abc",
    });
    const consumed = store.consume(created.inspectionId);
    expect(consumed?.ip).toBe("203.0.113.10");
    expect(store.consume(created.inspectionId)).toBeNull();
  });

  it("expires stored inspections", () => {
    const store = new SshInspectionStore(-1);
    const created = store.create({
      hostname: "vps.example",
      ip: "203.0.113.10",
      port: 22,
      username: "root",
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:abc",
    });
    expect(store.consume(created.inspectionId)).toBeNull();
  });
});
