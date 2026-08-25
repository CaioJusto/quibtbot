import { describe, expect, it } from "vitest";
import {
  isServing,
  parseTailscaleStatus,
  remoteAccessFrom,
  remoteAccessLabel,
  serveArgs,
  serveUrl,
} from "./tailscale.js";

describe("parseTailscaleStatus", () => {
  it("reads the tailnet name and IPv4 when the backend is running", () => {
    const state = parseTailscaleStatus(
      JSON.stringify({
        BackendState: "Running",
        Self: {
          DNSName: "mac-do-caio.tail1234.ts.net.",
          TailscaleIPs: ["100.101.102.103", "fd7a::1"],
        },
      }),
    );
    expect(state).toEqual({
      kind: "ready",
      dnsName: "mac-do-caio.tail1234.ts.net",
      ip: "100.101.102.103",
    });
  });

  it("treats a logged-out backend as not ready", () => {
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: "NeedsLogin" }))).toEqual({
      kind: "logged-out",
    });
  });

  it("treats unreadable output as no tailscale at all", () => {
    expect(parseTailscaleStatus("command not found")).toEqual({ kind: "missing" });
  });
});

describe("serve", () => {
  it("publishes the local API over the tailnet certificate", () => {
    expect(serveArgs(3100)).toEqual(["serve", "--bg", "--https=443", "http://127.0.0.1:3100"]);
    expect(serveUrl("mac-do-caio.tail1234.ts.net")).toBe("https://mac-do-caio.tail1234.ts.net");
  });

  it("knows whether the API port is already published", () => {
    expect(isServing("", 3100)).toBe(false);
    expect(
      isServing("https://mac.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:3100", 3100),
    ).toBe(true);
    // Outra porta publicada não conta como a nossa.
    expect(isServing("|-- / proxy http://127.0.0.1:8080", 3100)).toBe(false);
  });
});

describe("remoteAccessFrom", () => {
  const ready = { kind: "ready", dnsName: "mac.tail1234.ts.net", ip: "100.101.102.103" } as const;

  it("is on only when tailscale is ready and the port is served", () => {
    expect(remoteAccessFrom(ready, true)).toEqual({
      kind: "on",
      url: "https://mac.tail1234.ts.net",
    });
    expect(remoteAccessFrom(ready, false)).toEqual({ kind: "off", reason: "not-serving" });
    expect(remoteAccessFrom({ kind: "missing" }, true)).toEqual({ kind: "off", reason: "missing" });
    expect(remoteAccessFrom({ kind: "logged-out" }, true)).toEqual({
      kind: "off",
      reason: "logged-out",
    });
  });

  it("tells the user what to do next, never the internal reason", () => {
    expect(remoteAccessLabel({ kind: "off", reason: "missing" })).toContain("Instale o Tailscale");
    expect(remoteAccessLabel({ kind: "off", reason: "logged-out" })).toContain(
      "entre na sua conta",
    );
    expect(remoteAccessLabel({ kind: "on", url: "https://x" })).toContain("qualquer rede");
  });
});
