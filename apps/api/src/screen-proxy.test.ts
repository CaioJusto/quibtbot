import { describe, expect, it } from "vitest";
import { resolveNovncTarget } from "../../web/src/screen-proxy.js";
import {
  addScreenProxyCapability,
  SCREEN_PROXY_TTL_MS,
  signStoredScreenUrl,
} from "./screen-proxy.js";

describe("screen proxy capability", () => {
  it("signs loopback Docker screen URLs without changing their destination", () => {
    const result = new URL(
      addScreenProxyCapability(
        "http://127.0.0.1:49152/embed.html?view_only=true",
        "secret",
        "https://app.example",
        100,
      ),
    );
    expect(result.origin).toBe("https://app.example");
    expect(result.pathname).toMatch(
      /^\/novnc\/[\w-]+\/49152\/300100\.[\w-]{43}\.view\/embed\.html$/,
    );
    expect(result.searchParams.get("view_only")).toBe("true");
  });

  it("does not modify managed-provider URLs", () => {
    const url = "https://sandbox.example/embed.html?token=provider-token";
    expect(addScreenProxyCapability(url, "secret", "https://app.example", 100)).toBe(url);
  });

  it("signs a stored driving URL and leaves an empty session as null", () => {
    expect(signStoredScreenUrl(null, "secret", "https://app.example")).toBeNull();
    const signed = signStoredScreenUrl(
      "http://127.0.0.1:49152/embed.html",
      "secret",
      "https://app.example",
      false,
    );
    expect(signed).toContain("/novnc/");
    expect(signed).toContain(".control/");
    expect(signed).toContain("view_only=false");
  });

  it("cryptographically separates view-only and control capabilities", () => {
    const view = signStoredScreenUrl(
      "http://127.0.0.1:49152/embed.html",
      "secret",
      "https://app.example",
      true,
    );
    const control = signStoredScreenUrl(
      "http://127.0.0.1:49152/embed.html",
      "secret",
      "https://app.example",
      false,
    );

    expect(view).toContain(".view/");
    expect(control).toContain(".control/");
    expect(new URL(view!).pathname).not.toBe(new URL(control!).pathname);
  });

  it("produces a capability the web proxy can resolve", () => {
    const signed = addScreenProxyCapability(
      "http://127.0.0.1:49152/embed.html?view_only=false",
      "secret",
      "https://app.example",
      100,
    );
    const path = new URL(signed).pathname + new URL(signed).search;
    expect(resolveNovncTarget(path, "secret", 100)).toEqual({
      hostname: "127.0.0.1",
      port: 49152,
      path: "/embed.html?view_only=false",
      viewOnly: false,
      // O proxy agora derruba o socket quando a permissão vence; para isso ele
      // precisa saber a hora do vencimento que assinou.
      expiresAt: 100 + SCREEN_PROXY_TTL_MS,
    });
  });
});
