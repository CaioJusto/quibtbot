import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import {
  bindProxySocketLifetime,
  resolveNovncTarget,
  safeProxyHeaders,
  safeProxyResponseHeaders,
  stripSensitiveHandshakeHeaders,
} from "./screen-proxy.js";

/** Proxies a signed noVNC HTTP request. Returns false for unrelated paths. */
export function proxyNovncHttp(req: IncomingMessage, res: ServerResponse, secret: string): boolean {
  if (!req.url?.startsWith("/novnc/")) return false;
  const target = resolveNovncTarget(req.url, secret);
  if (!target) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Invalid or expired screen capability");
    return true;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, {
      allow: "GET, HEAD",
      "content-type": "text/plain; charset=utf-8",
    });
    res.end("Method not allowed");
    return true;
  }
  const headers = {
    ...safeProxyHeaders(req.headers),
    host: `${target.hostname}:${target.port}`,
  };
  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: target.path,
      method: req.method,
      headers,
    },
    (incoming) => {
      res.writeHead(incoming.statusCode ?? 502, safeProxyResponseHeaders(incoming.headers));
      incoming.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end(error.message);
  });
  // `req` "close" fires after the request body has been consumed. The response
  // is the lifetime that matters for embed.html and the other noVNC assets.
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
  return true;
}

/** Attaches the signed noVNC WebSocket tunnel to a Node HTTP server. */
export function attachNovncUpgrade(
  server: http.Server,
  secret: string,
  options: {
    rejectUnmatched?: boolean;
    authorizeRequest?: (req: IncomingMessage) => boolean;
  } = {},
): void {
  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/novnc/")) {
      if (options.rejectUnmatched) socket.destroy();
      return;
    }
    if (options.authorizeRequest && !options.authorizeRequest(req)) {
      socket.destroy();
      return;
    }
    const target = resolveNovncTarget(req.url, secret);
    if (!target) {
      socket.destroy();
      return;
    }
    const upstream = net.connect(target.port, target.hostname, () => {
      const headerLines = [
        `${req.method ?? "GET"} ${target.path} HTTP/1.1`,
        `Host: ${target.hostname}:${target.port}`,
      ];
      for (const [key, value] of Object.entries(safeProxyHeaders(req.headers))) {
        headerLines.push(`${key}: ${Array.isArray(value) ? value.join(",") : value}`);
      }
      upstream.write(`${headerLines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      const responseChunks: Buffer[] = [];
      let responseSize = 0;
      let responseTail = Buffer.alloc(0);
      const forwardHandshake = (chunk: Buffer) => {
        responseChunks.push(chunk);
        responseSize += chunk.length;
        if (responseSize > 64 * 1024) {
          socket.destroy();
          upstream.destroy();
          return;
        }
        const boundarySearch = Buffer.concat([responseTail, chunk]);
        if (boundarySearch.indexOf("\r\n\r\n") < 0) {
          responseTail = Buffer.from(boundarySearch.subarray(-3));
          return;
        }
        const responseHead = Buffer.concat(responseChunks, responseSize);
        const safe = stripSensitiveHandshakeHeaders(responseHead);
        if (!safe) {
          socket.destroy();
          upstream.destroy();
          return;
        }
        upstream.off("data", forwardHandshake);
        socket.write(safe);
        upstream.pipe(socket);
      };
      upstream.on("data", forwardHandshake);
    });
    bindProxySocketLifetime(socket, upstream, target.expiresAt);
  });
}
