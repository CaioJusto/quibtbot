import { describe, expect, it } from "vitest";
import { deepLinkIs, parseAppDeepLink } from "./deep-link";

describe("parseAppDeepLink", () => {
  it("reads the native plugin callback", () => {
    const parsed = parseAppDeepLink("quibt://plugins/callback?connectionId=conn_1");
    expect(parsed?.path).toBe("plugins/callback");
    expect(parsed?.searchParams.get("connectionId")).toBe("conn_1");
  });

  it("reads Expo Go's /--/ route for the same callback", () => {
    const parsed = parseAppDeepLink(
      "exp://192.168.1.20:8081/--/plugins/callback?connectionId=conn_2",
    );
    expect(parsed?.path).toBe("plugins/callback");
    expect(parsed?.searchParams.get("connectionId")).toBe("conn_2");
  });

  it("reads connect, bootstrap and billing host-style links", () => {
    expect(parseAppDeepLink("quibt://connect?api=https%3A%2F%2Fapp.example")?.path).toBe("connect");
    expect(parseAppDeepLink("quibt://bootstrap?api=https%3A%2F%2Fapp.example")?.path).toBe(
      "bootstrap",
    );
    expect(parseAppDeepLink("quibt://billing")?.path).toBe("billing");
  });

  it("rejects malformed input", () => {
    expect(parseAppDeepLink("not a url")).toBeNull();
    expect(parseAppDeepLink("")).toBeNull();
  });
});

describe("deepLinkIs", () => {
  it("matches the plugin callback aliases the layout understands", () => {
    expect(deepLinkIs("plugins/callback", "plugins/callback", "plugins")).toBe(true);
    expect(deepLinkIs("plugins", "plugins/callback", "plugins")).toBe(true);
    expect(deepLinkIs("connect", "plugins/callback", "plugins")).toBe(false);
  });
});
