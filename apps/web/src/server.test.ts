import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  apiProxyHeaders,
  apiProxyResponseHeaders,
  createWebServer,
  isAllowedWebHost,
  isAllowedWebSocketOrigin,
  isApiProxyPath,
  normalizedRequestTarget,
} from "./server.js";
import { internalProxyProof } from "./server-keys.js";

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  return address.port;
}

describe("production web server routing", () => {
  it("matches only complete API route prefixes", () => {
    expect(isApiProxyPath("/api")).toBe(true);
    expect(isApiProxyPath("/rpc/health")).toBe(true);
    expect(isApiProxyPath("/files/x")).toBe(true);
    expect(isApiProxyPath("/hooks/wh_1")).toBe(true);
    expect(isApiProxyPath("/api-attacker")).toBe(false);
    expect(isApiProxyPath("/rpcx")).toBe(false);
  });

  it("normalizes absolute-form request lines and enforces same-origin browser upgrades", () => {
    expect(normalizedRequestTarget("http://evil.example/rpc/health?full=1")).toEqual({
      pathname: "/rpc/health",
      path: "/rpc/health?full=1",
    });
    expect(isAllowedWebSocketOrigin("https://quibt.example", "quibt.example")).toBe(true);
    expect(isAllowedWebSocketOrigin(undefined, "quibt.example")).toBe(true);
    expect(isAllowedWebSocketOrigin("https://evil.example", "quibt.example")).toBe(false);
    expect(isAllowedWebSocketOrigin("null", "quibt.example")).toBe(false);
  });

  it("allows IP, localhost, and configured origins but blocks arbitrary Host headers", () => {
    expect(isAllowedWebHost("127.0.0.1:5173", [])).toBe(true);
    expect(isAllowedWebHost("[::1]:5173", [])).toBe(true);
    expect(isAllowedWebHost("studio.localhost:5173", [])).toBe(true);
    expect(isAllowedWebHost("quibt.example.com", ["quibt.example.com"])).toBe(true);
    expect(isAllowedWebHost("evil.example", ["quibt.example.com"])).toBe(false);
    expect(isAllowedWebHost("quibt.example.com@evil.example", ["quibt.example.com"])).toBe(false);
  });

  it("overwrites the internal proof and preserves the complete forwarded client chain", () => {
    const headers = apiProxyHeaders(
      {
        headers: {
          connection: "keep-alive, x-remove-me",
          host: "127.0.0.1:5173",
          "x-forwarded-for": "203.0.113.8",
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "https",
          "x-quibt-internal-proxy": "attacker",
          "x-real-ip": "127.0.0.1",
          "x-remove-me": "secret",
        },
        socket: { remoteAddress: "127.0.0.1" } as never,
      },
      new URL("http://api:3100"),
      "trusted-proof",
    );
    expect(headers.host).toBe("api:3100");
    expect(headers["x-quibt-internal-proxy"]).toBe("trusted-proof");
    expect(headers["x-forwarded-for"]).toBe("203.0.113.8, 127.0.0.1");
    expect(headers["x-forwarded-host"]).toBe("127.0.0.1:5173");
    expect(headers["x-forwarded-proto"]).toBe("http");
    expect(headers["x-real-ip"]).toBe("127.0.0.1");
    expect(headers["x-remove-me"]).toBeUndefined();
    expect(headers.connection).toBeUndefined();
  });

  it("drops a spoofed forwarded chain when the socket has no peer address", () => {
    const headers = apiProxyHeaders(
      {
        headers: {
          host: "127.0.0.1:5173",
          "x-forwarded-for": "127.0.0.1",
          "x-real-ip": "127.0.0.1",
        },
        socket: { remoteAddress: undefined } as never,
      },
      new URL("http://api:3100"),
      "trusted-proof",
    );
    expect(headers["x-forwarded-for"]).toBeUndefined();
    expect(headers["x-real-ip"]).toBeUndefined();
  });

  it("removes hop-by-hop API response headers, including Connection-nominated fields", () => {
    expect(
      apiProxyResponseHeaders({
        connection: "keep-alive, x-private",
        "keep-alive": "timeout=5",
        "content-type": "application/json",
        "x-private": "secret",
      }),
    ).toEqual({ "content-type": "application/json" });
  });

  it("serves the SPA, immutable assets, health, and the streaming API proxy", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "quibt-web-server-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(
      path.join(dir, "index.html"),
      "<!doctype html><title>Quibt</title><main>app</main>",
    );
    const assets = path.join(dir, "assets");
    mkdirSync(assets);
    const assetSource = "console.log('ok')";
    writeFileSync(path.join(assets, "app-123.js"), assetSource);
    writeFileSync(path.join(assets, "app-123.js.br"), brotliCompressSync(assetSource));

    const authSecret = "test-web-secret-0123456789abcdef0123456789";
    const api = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            body,
            proof: req.headers["x-quibt-internal-proxy"],
            forwardedHost: req.headers["x-forwarded-host"],
            forwardedFor: req.headers["x-forwarded-for"],
          }),
        );
      });
    });
    const apiPort = await listen(api);
    const web = createWebServer({
      distDir: dir,
      env: {
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: authSecret,
        API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
      },
    });
    const webPort = await listen(web);
    const origin = `http://127.0.0.1:${webPort}`;

    const health = await fetch(`${origin}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, service: "web" });

    const route = await fetch(`${origin}/bots/one`, { headers: { accept: "text/html" } });
    expect(route.status).toBe(200);
    expect(await route.text()).toContain("<main>app</main>");

    const asset = await fetch(`${origin}/assets/app-123.js`, {
      headers: { "accept-encoding": "br" },
    });
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(asset.headers.get("content-encoding")).toBe("br");
    expect(asset.headers.get("vary")).toBe("Accept-Encoding");
    expect(await asset.text()).toContain("console.log");

    const missing = await fetch(`${origin}/assets/missing.js`, {
      headers: { accept: "text/html" },
    });
    expect(missing.status).toBe(404);

    const proxied = await fetch(`${origin}/rpc/echo`, { method: "POST", body: "hello" });
    expect(proxied.status).toBe(200);
    expect(await proxied.json()).toMatchObject({
      body: "hello",
      proof: internalProxyProof(authSecret),
      forwardedHost: `127.0.0.1:${webPort}`,
    });
  });
});
