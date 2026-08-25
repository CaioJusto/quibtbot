import { describe, expect, it } from "vitest";
import {
  bootstrapDeepLink,
  connectApiBase,
  connectDeepLink,
  connectLinkIsReachable,
  defaultPhoneConnectReach,
  LOCAL_PHONE_TUNNEL_TARGET,
  localPhoneTunnelCommand,
  normalizeRemoteConnectApi,
  parseConnectDeepLink,
  qrImageSrc,
  qrSvg,
} from "./device-connect.js";

describe("device connect", () => {
  it("round-trips the API URL through the deep link the camera opens", () => {
    const link = connectDeepLink("http://192.168.1.20:3100");
    expect(link).toBe("quibt://connect?api=http%3A%2F%2F192.168.1.20%3A3100");
    expect(parseConnectDeepLink(link)).toEqual({ api: "http://192.168.1.20:3100" });
  });

  it("carries the one-time pairing token when the computer minted one", () => {
    const link = connectDeepLink("http://192.168.1.20:3100", "otp-123");
    expect(parseConnectDeepLink(link)).toEqual({
      api: "http://192.168.1.20:3100",
      pair: "otp-123",
    });
    // Sem token o link continua valendo: o celular chega no servidor e pede a senha.
    expect(parseConnectDeepLink(connectDeepLink("http://a.b"))).toEqual({ api: "http://a.b" });
  });

  it("uses a distinct first-install link so the mobile app exchanges an owner invite", () => {
    expect(bootstrapDeepLink("https://quibt.example.com/", "invite-secret")).toBe(
      "quibt://bootstrap?api=https%3A%2F%2Fquibt.example.com&token=invite-secret",
    );
  });

  it("draws the QR locally, because the link carries a credential", () => {
    const svg = qrSvg("quibt://connect?api=http%3A%2F%2Fx&pair=secret");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("<path");
    expect(qrImageSrc("x").startsWith("data:image/svg+xml;utf8,")).toBe(true);
    // Nada de mandar o token para um gerador de QR de terceiro: o dado vira desenho aqui.
    expect(svg).not.toContain("secret");
    expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', "")).not.toContain("http");
    expect(qrImageSrc("x")).not.toContain("qrserver");
  });

  it("ignores unrelated quibt links", () => {
    expect(parseConnectDeepLink("quibt://billing")).toBeNull();
    expect(parseConnectDeepLink("https://example.com")).toBeNull();
  });

  it("uses the LAN API when the desktop UI is still on loopback", () => {
    expect(
      connectApiBase({
        pageHost: "127.0.0.1",
        pageOrigin: "http://127.0.0.1:5173",
        lanApi: "http://192.168.1.20:3100",
      }),
    ).toBe("http://192.168.1.20:3100");
    expect(
      connectApiBase({
        pageHost: "app.example.com",
        pageOrigin: "https://app.example.com",
        lanApi: "http://192.168.1.20:3100",
      }),
    ).toBe("https://app.example.com");
  });

  it("puts a user-owned HTTPS tunnel in the QR so a local PC is reachable off the LAN", () => {
    expect(normalizeRemoteConnectApi("https://quibt.trycloudflare.com/")).toBe(
      "https://quibt.trycloudflare.com",
    );
    expect(normalizeRemoteConnectApi("https://pc.tailnet.ts.net")).toBe(
      "https://pc.tailnet.ts.net",
    );
    expect(normalizeRemoteConnectApi("http://quibt.trycloudflare.com")).toBeNull();
    expect(normalizeRemoteConnectApi("https://127.0.0.1")).toBeNull();
    expect(normalizeRemoteConnectApi("https://user:pass@evil.example")).toBeNull();
    expect(defaultPhoneConnectReach("https://quibt.trycloudflare.com")).toBe("remote");
    expect(defaultPhoneConnectReach(null)).toBe("lan");
    expect(
      connectApiBase({
        pageHost: "127.0.0.1",
        pageOrigin: "http://127.0.0.1:5173",
        lanApi: "http://192.168.1.20:3100",
        remoteApi: "https://quibt.trycloudflare.com/",
      }),
    ).toBe("https://quibt.trycloudflare.com");
    expect(
      connectApiBase({
        pageHost: "127.0.0.1",
        pageOrigin: "http://127.0.0.1:5173",
        lanApi: "http://192.168.1.20:3100",
        remoteApi: "https://quibt.trycloudflare.com",
        reach: "lan",
      }),
    ).toBe("http://192.168.1.20:3100");
    expect(localPhoneTunnelCommand()).toBe(`cloudflared tunnel --url ${LOCAL_PHONE_TUNNEL_TARGET}`);
  });

  it("inherits the VPS currently open on desktop, even when local or stale tunnel data exists", () => {
    expect(
      connectApiBase({
        pageHost: "quibt.my-vps.example",
        pageOrigin: "https://quibt.my-vps.example",
        lanApi: "http://192.168.1.20:3100",
        remoteApi: "https://old-tunnel.example",
        reach: "remote",
      }),
    ).toBe("https://quibt.my-vps.example");
  });
});

describe("connectLinkIsReachable", () => {
  it("refuses loopback: on a phone that address is the phone itself", () => {
    expect(connectLinkIsReachable("http://127.0.0.1:3100")).toBe(false);
    expect(connectLinkIsReachable("http://localhost:3100")).toBe(false);
    expect(connectLinkIsReachable("http://[::1]:3100")).toBe(false);
  });

  it("accepts an address another device can dial", () => {
    expect(connectLinkIsReachable("http://192.168.1.20:3100")).toBe(true);
    expect(connectLinkIsReachable("https://mac.tail1234.ts.net")).toBe(true);
    expect(connectLinkIsReachable("https://quibt.example.com")).toBe(true);
  });

  it("treats junk as unreachable instead of throwing", () => {
    expect(connectLinkIsReachable("nao é url")).toBe(false);
    expect(connectLinkIsReachable("")).toBe(false);
  });
});
