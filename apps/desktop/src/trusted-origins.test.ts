import { describe, expect, it } from "vitest";
import { TrustedOriginPolicy } from "./trusted-origins.js";

describe("TrustedOriginPolicy", () => {
  it("keeps only local and current remote origins", () => {
    const policy = new TrustedOriginPolicy("http://127.0.0.1:5173");
    policy.setRemote("https://remote.example.com");
    expect(policy.getOrigins()).toEqual(
      new Set(["http://127.0.0.1:5173", "https://remote.example.com"]),
    );
    expect(policy.isTrusted("https://remote.example.com/path")).toBe(true);
    expect(policy.isLocal("http://127.0.0.1:5173/account")).toBe(true);
    expect(policy.isLocal("https://remote.example.com/path")).toBe(false);
    expect(policy.isTrusted("https://other.example.com")).toBe(false);
  });

  it("drops the previous remote origin when switching or clearing", () => {
    const policy = new TrustedOriginPolicy("http://127.0.0.1:5173");
    policy.setRemote("https://first.example.com");
    policy.setRemote("https://second.example.com");
    expect(policy.isTrusted("https://first.example.com")).toBe(false);
    expect(policy.isTrusted("https://second.example.com")).toBe(true);
    policy.setRemote(null);
    expect(policy.getOrigins()).toEqual(new Set(["http://127.0.0.1:5173"]));
  });
});
