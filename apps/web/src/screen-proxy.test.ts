import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  bindProxySocketLifetime,
  resolveNovncTarget,
  safeProxyHeaders,
  safeProxyResponseHeaders,
  stripSensitiveHandshakeHeaders,
} from "./screen-proxy.js";

function signedPath(
  port: number,
  expiresAt: number,
  secret: string,
  rest = "/embed.html",
  hostname = "127.0.0.1",
  mode: "view" | "control" = "view",
) {
  const signature = createHmac("sha256", secret)
    .update(`${hostname}:${port}:${expiresAt}:${mode}`)
    .digest("base64url");
  const target = Buffer.from(hostname).toString("base64url");
  return `/novnc/${target}/${port}/${expiresAt}.${signature}.${mode}${rest}`;
}

describe("noVNC proxy authorization", () => {
  it("accepts signed, unexpired loopback targets", () => {
    expect(resolveNovncTarget(signedPath(49152, 2_000, "secret"), "secret", 1_000)).toEqual({
      hostname: "127.0.0.1",
      port: 49152,
      path: "/embed.html?view_only=true",
      viewOnly: true,
      expiresAt: 2_000,
    });
  });

  it("rejects the previous capability format that did not bind a mode", () => {
    const hostname = "127.0.0.1";
    const signature = createHmac("sha256", "secret")
      .update(`${hostname}:49152:2000`)
      .digest("base64url");
    const target = Buffer.from(hostname).toString("base64url");
    expect(
      resolveNovncTarget(`/novnc/${target}/49152/2000.${signature}/embed.html`, "secret", 1_000),
    ).toBeNull();
  });

  it("rejects arbitrary ports, bad signatures, and expired capabilities", () => {
    expect(resolveNovncTarget("/novnc/5432/index.html", "secret", 1_000)).toBeNull();
    expect(resolveNovncTarget(signedPath(49152, 2_000, "wrong"), "secret", 1_000)).toBeNull();
    expect(resolveNovncTarget(signedPath(49152, 999, "secret"), "secret", 1_000)).toBeNull();
    expect(
      resolveNovncTarget(
        signedPath(49152, 2_000, "secret", "/embed.html", "198.51.100.9"),
        "secret",
        1_000,
      ),
    ).toBeNull();
  });

  it("serves the whole screen server so noVNC can load its own scripts and socket", () => {
    // O cliente noVNC pede core/rfb.js e abre o WebSocket em outro caminho: presos à
    // assinatura de um arquivo só, esses pedidos voltavam 403 e a tela ficava preta.
    for (const rest of ["/embed.html", "/core/rfb.js", "/websockify"]) {
      expect(resolveNovncTarget(signedPath(49152, 2_000, "secret", rest), "secret", 1_000)).toEqual(
        {
          hostname: "127.0.0.1",
          port: 49152,
          path: rest === "/embed.html" ? "/embed.html?view_only=true" : rest,
          viewOnly: true,
          expiresAt: 2_000,
        },
      );
    }
    // A permissão vem do escopo assinado, nunca da query controlada pelo cliente.
    expect(
      resolveNovncTarget(`${signedPath(49152, 2_000, "secret")}?view_only=false`, "secret", 1_000),
    ).toEqual({
      hostname: "127.0.0.1",
      port: 49152,
      path: "/embed.html?view_only=true",
      viewOnly: true,
      expiresAt: 2_000,
    });
  });

  it("keeps control capabilities distinct from view-only capabilities", () => {
    expect(
      resolveNovncTarget(
        `${signedPath(49152, 2_000, "secret", "/embed.html", "127.0.0.1", "control")}?view_only=true`,
        "secret",
        1_000,
      ),
    ).toEqual({
      hostname: "127.0.0.1",
      port: 49152,
      path: "/embed.html?view_only=false",
      viewOnly: false,
      expiresAt: 2_000,
    });
  });

  it("destroys the upstream noVNC socket when the browser hangs up", () => {
    const events = new Map<string, Array<() => void>>();
    const on = (event: string, listener: () => void) => {
      const list = events.get(event) ?? [];
      list.push(listener);
      events.set(event, list);
    };
    const client = { on, destroy: vi.fn(), name: "client" };
    const upstream = { on, destroy: vi.fn(), name: "upstream" };
    bindProxySocketLifetime(client, upstream);
    for (const listener of events.get("close") ?? []) listener();
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(upstream.destroy).toHaveBeenCalledTimes(1);
    for (const listener of events.get("close") ?? []) listener();
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(upstream.destroy).toHaveBeenCalledTimes(1);
  });

  it("does not forward application credentials", () => {
    expect(
      safeProxyHeaders({
        host: "app.example",
        cookie: "session=secret",
        authorization: "Bearer secret",
        "proxy-authorization": "Basic secret",
        upgrade: "websocket",
        "sec-websocket-key": "key",
      }),
    ).toEqual({ upgrade: "websocket", "sec-websocket-key": "key" });
  });

  it("does not accept cookie or site-data mutations from a bot computer", () => {
    expect(
      safeProxyResponseHeaders({
        "content-type": "text/html",
        "set-cookie": ["session=attacker"],
        "clear-site-data": '"cookies"',
      }),
    ).toEqual({ "content-type": "text/html" });

    const handshake = Buffer.from(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSet-Cookie: session=attacker\r\n\r\nframe",
      "latin1",
    );
    expect(stripSensitiveHandshakeHeaders(handshake)?.toString("latin1")).toBe(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\nframe",
    );
  });
});

describe("prazo do socket da tela", () => {
  function fakeSocket() {
    const listeners: Record<string, Array<() => void>> = {};
    return {
      destroyed: false,
      on(event: string, listener: () => void) {
        const eventListeners = listeners[event] ?? [];
        listeners[event] = eventListeners;
        eventListeners.push(listener);
      },
      destroy() {
        this.destroyed = true;
      },
    };
  }

  it("derruba a conexão quando a permissão assinada expira", () => {
    vi.useFakeTimers();
    const client = fakeSocket();
    const upstream = fakeSocket();
    const now = 1_000_000;
    bindProxySocketLifetime(client, upstream, now + 5_000, () => now);
    expect(client.destroyed).toBe(false);
    vi.advanceTimersByTime(5_001);
    expect(client.destroyed).toBe(true);
    expect(upstream.destroyed).toBe(true);
    vi.useRealTimers();
  });

  it("recusa de imediato uma permissão já vencida", () => {
    const client = fakeSocket();
    const upstream = fakeSocket();
    bindProxySocketLifetime(client, upstream, 10, () => 1_000);
    expect(client.destroyed).toBe(true);
  });

  it("sem prazo, segue valendo o comportamento antigo", () => {
    vi.useFakeTimers();
    const client = fakeSocket();
    const upstream = fakeSocket();
    bindProxySocketLifetime(client, upstream);
    vi.advanceTimersByTime(600_000);
    expect(client.destroyed).toBe(false);
    vi.useRealTimers();
  });
});
