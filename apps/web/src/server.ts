import { createReadStream, type Stats } from "node:fs";
import { stat } from "node:fs/promises";
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { previewAllowedHosts, screenProxySecretFor } from "./build-config.js";
import { attachNovncUpgrade, proxyNovncHttp } from "./node-screen-proxy.js";
import { internalProxyProof, screenProxySecret } from "./server-keys.js";

const API_PREFIXES = ["/api", "/rpc", "/files", "/hooks"];
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function normalizedRequestTarget(rawUrl: string | undefined): {
  pathname: string;
  path: string;
} | null {
  try {
    const parsed = new URL(rawUrl ?? "/", "http://web.local");
    return { pathname: parsed.pathname, path: `${parsed.pathname}${parsed.search}` };
  } catch {
    return null;
  }
}

export function isApiProxyPath(pathname: string): boolean {
  return API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function hostnameFromHeader(host: string | undefined): string | null {
  if (!host || /[\s/@]/.test(host)) return null;
  try {
    return new URL(`http://${host}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

export function isAllowedWebHost(
  host: string | undefined,
  configuredHosts: readonly string[],
): boolean {
  const hostname = hostnameFromHeader(host);
  if (!hostname) return false;
  if (isIP(hostname)) return true;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  return configuredHosts.some((candidate) => candidate.toLowerCase() === hostname);
}

export function isAllowedWebSocketOrigin(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  // Non-browser clients do not send Origin. Browsers always do, so require their
  // WebSocket origin to be the exact public authority they are upgrading through.
  if (origin == null) return true;
  if (origin === "null" || !host || /[\s/@]/.test(host)) return false;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.host.toLowerCase() === host.toLowerCase()
    );
  } catch {
    return false;
  }
}

function forwardedValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}

export function apiProxyHeaders(
  req: Pick<IncomingMessage, "headers" | "socket">,
  target: URL,
  proof: string,
  externalProtocol?: "http" | "https",
): IncomingHttpHeaders {
  const connectionTokens = new Set(
    (forwardedValue(req.headers.connection) ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const headers: IncomingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const normalizedKey = key.toLowerCase();
    if (
      value == null ||
      HOP_BY_HOP.has(normalizedKey) ||
      connectionTokens.has(normalizedKey) ||
      normalizedKey === "x-forwarded-for" ||
      normalizedKey === "x-forwarded-host" ||
      normalizedKey === "x-forwarded-proto" ||
      normalizedKey === "x-real-ip" ||
      normalizedKey === "x-quibt-internal-proxy"
    ) {
      continue;
    }
    headers[key] = value;
  }
  headers.host = target.host;
  headers["x-quibt-internal-proxy"] = proof;
  const peer = req.socket.remoteAddress;
  const existingForwardedFor = forwardedValue(req.headers["x-forwarded-for"]);
  if (peer) {
    headers["x-forwarded-for"] = existingForwardedFor ? `${existingForwardedFor}, ${peer}` : peer;
    // Unlike X-Forwarded-For (where the API validates the complete chain), X-Real-IP is
    // a single assertion. It must come from this proxy, never from the browser.
    headers["x-real-ip"] = peer;
  }
  headers["x-forwarded-host"] = forwardedValue(req.headers.host);
  headers["x-forwarded-proto"] =
    externalProtocol ?? ((req.socket as { encrypted?: boolean }).encrypted ? "https" : "http");
  return headers;
}

export function apiProxyResponseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const connectionTokens = new Set(
    (forwardedValue(headers.connection) ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const safe: IncomingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();
    if (value == null || HOP_BY_HOP.has(normalizedKey) || connectionTokens.has(normalizedKey)) {
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

function configuredRequestProtocol(
  req: Pick<IncomingMessage, "headers" | "socket">,
  env: NodeJS.ProcessEnv,
): "http" | "https" {
  if ((req.socket as { encrypted?: boolean }).encrypted) return "https";
  const requestHostname = hostnameFromHeader(forwardedValue(req.headers.host));
  for (const raw of [env.WEB_ORIGIN, env.BETTER_AUTH_URL]) {
    if (!raw) continue;
    try {
      const configured = new URL(raw);
      if (
        configured.hostname.toLowerCase() === requestHostname &&
        (configured.protocol === "http:" || configured.protocol === "https:")
      ) {
        return configured.protocol.slice(0, -1) as "http" | "https";
      }
    } catch {
      // Invalid public origins are rejected by the API's own startup configuration.
    }
  }
  return "http";
}

function proxyApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  target: URL,
  proof: string,
  externalProtocol: "http" | "https",
  requestTarget: string,
): void {
  const transport = target.protocol === "https:" ? https : http;
  const basePath = target.pathname.replace(/\/$/, "");
  const upstream = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: req.method,
      // Never forward an absolute-form request target supplied by a client. The API must
      // see only the normalized origin-form path under the configured upstream origin.
      path: `${basePath}${requestTarget}`,
      headers: apiProxyHeaders(req, target, proof, externalProtocol),
    },
    (incoming) => {
      res.writeHead(incoming.statusCode ?? 502, apiProxyResponseHeaders(incoming.headers));
      incoming.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end(`API proxy unavailable: ${error.message}`);
  });
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
}

function cacheControlFor(filePath: string): string {
  return filePath.includes(`${path.sep}assets${path.sep}`)
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

function weakEtag(file: Stats): string {
  return `W/"${file.size.toString(16)}-${Math.trunc(file.mtimeMs).toString(16)}"`;
}

function acceptsEncoding(header: string | string[] | undefined, encoding: "br" | "gzip"): boolean {
  const value = forwardedValue(header);
  if (!value) return false;
  return value.split(",").some((part) => {
    const [name, ...parameters] = part.trim().toLowerCase().split(";");
    if (name !== encoding && name !== "*") return false;
    const quality = parameters
      .map((parameter) => parameter.trim().match(/^q=([0-9.]+)$/)?.[1])
      .find(Boolean);
    return quality == null || Number(quality) > 0;
  });
}

async function existingFile(filePath: string): Promise<{ path: string; stats: Stats } | null> {
  try {
    const stats = await stat(filePath);
    return stats.isFile() ? { path: filePath, stats } : null;
  } catch {
    return null;
  }
}

async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  stats: Stats,
) {
  let representation = { path: filePath, stats, encoding: undefined as "br" | "gzip" | undefined };
  if (acceptsEncoding(req.headers["accept-encoding"], "br")) {
    const compressed = await existingFile(`${filePath}.br`);
    if (compressed) representation = { ...compressed, encoding: "br" };
  }
  if (representation.encoding == null && acceptsEncoding(req.headers["accept-encoding"], "gzip")) {
    const compressed = await existingFile(`${filePath}.gz`);
    if (compressed) representation = { ...compressed, encoding: "gzip" };
  }
  const etag = weakEtag(representation.stats);
  const headers: Record<string, string> = {
    "cache-control": cacheControlFor(filePath),
    "content-length": String(representation.stats.size),
    "content-type":
      CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
    etag,
    "last-modified": representation.stats.mtime.toUTCString(),
    vary: "Accept-Encoding",
    "x-content-type-options": "nosniff",
  };
  if (representation.encoding) headers["content-encoding"] = representation.encoding;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, {
      etag,
      "cache-control": headers["cache-control"],
      vary: headers.vary,
    });
    res.end();
    return;
  }
  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(representation.path);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

async function serveStaticRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  distDir: string,
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
    return;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("Bad request");
    return;
  }
  if (decoded.includes("\0")) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("Bad request");
    return;
  }
  const root = path.resolve(distDir);
  const candidate = path.resolve(root, `.${decoded === "/" ? "/index.html" : decoded}`);
  const insideRoot = candidate === root || candidate.startsWith(`${root}${path.sep}`);
  const asset = insideRoot ? await existingFile(candidate) : null;
  if (asset) {
    await serveFile(req, res, asset.path, asset.stats);
    return;
  }
  const acceptsHtml = (req.headers.accept ?? "").includes("text/html");
  if (acceptsHtml && !path.extname(decoded)) {
    const index = await existingFile(path.join(root, "index.html"));
    if (index) {
      await serveFile(req, res, index.path, index.stats);
      return;
    }
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

export type WebServerOptions = {
  env?: NodeJS.ProcessEnv;
  distDir?: string;
};

export function createWebServer(options: WebServerOptions = {}): http.Server {
  const env = options.env ?? process.env;
  const authSecret = screenProxySecretFor("serve", env);
  const apiTarget = new URL(env.API_PROXY_TARGET ?? "http://127.0.0.1:3100");
  if (apiTarget.protocol !== "http:" && apiTarget.protocol !== "https:") {
    throw new Error("API_PROXY_TARGET must use http or https");
  }
  if (apiTarget.username || apiTarget.password || apiTarget.search || apiTarget.hash) {
    throw new Error(
      "API_PROXY_TARGET must be an HTTP origin without credentials, query, or fragment",
    );
  }
  const distDir = options.distDir ?? path.resolve(import.meta.dirname, "../dist");
  const allowedHosts = previewAllowedHosts(env);
  const proxyProof = internalProxyProof(authSecret);
  const capabilitySecret = screenProxySecret(authSecret);

  const server = http.createServer((req, res) => {
    if (!isAllowedWebHost(req.headers.host, allowedHosts)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Blocked request host");
      return;
    }
    if (proxyNovncHttp(req, res, capabilitySecret)) return;
    const requestTarget = normalizedRequestTarget(req.url);
    if (!requestTarget) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Bad request");
      return;
    }
    if (isApiProxyPath(requestTarget.pathname)) {
      proxyApiRequest(
        req,
        res,
        apiTarget,
        proxyProof,
        configuredRequestProtocol(req, env),
        requestTarget.path,
      );
      return;
    }
    if (requestTarget.pathname === "/health") {
      res.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      });
      res.end('{"ok":true,"service":"web"}');
      return;
    }
    void serveStaticRequest(req, res, requestTarget.pathname, distDir).catch((error) => {
      console.error("web static response failed", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end("Internal server error");
    });
  });
  attachNovncUpgrade(server, capabilitySecret, {
    rejectUnmatched: true,
    authorizeRequest: (req) =>
      isAllowedWebHost(req.headers.host, allowedHosts) &&
      isAllowedWebSocketOrigin(forwardedValue(req.headers.origin), req.headers.host),
  });
  return server;
}

export async function startWebServer(options: WebServerOptions = {}): Promise<http.Server> {
  const env = options.env ?? process.env;
  const host = env.WEB_HOST ?? "127.0.0.1";
  const port = Number(env.WEB_PORT ?? 5173);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("WEB_PORT must be an integer between 1 and 65535");
  }
  const server = createWebServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  console.log(`Quibt web listening on http://${host}:${port}`);
  return server;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  void startWebServer()
    .then((server) => {
      const shutdown = () => server.close(() => process.exit(0));
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
