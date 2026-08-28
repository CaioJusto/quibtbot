import { createHmac } from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type PreviewServer, type ViteDevServer } from "vite";
import { previewAllowedHosts, screenProxySecretFor } from "./src/build-config.js";
import {
  bindProxySocketLifetime,
  resolveNovncTarget,
  safeProxyHeaders,
  safeProxyResponseHeaders,
  stripSensitiveHandshakeHeaders,
} from "./src/screen-proxy.js";

const webPort = Number(process.env.WEB_PORT ?? 5173);

/**
 * Espelho de `deriveDomainKey`/`internalProxyProof` de `apps/api/src/app.ts`.
 *
 * Este arquivo não pode importar `@quibt/core` nem a API (ver o comentário de
 * `apps/web/src/build-config.ts`), então a derivação é copiada. Os dois lados precisam
 * chegar ao MESMO valor: `apps/api/src/domain-keys.test.ts` guarda os rótulos.
 */
const SCREEN_CAPABILITY_LABEL = "quibt-bot/screen-capability/v1";
const INTERNAL_PROXY_LABEL = "quibt-bot/internal-proxy-proof/v1";

function deriveDomainKey(authSecret: string, label: string): string {
  return createHmac("sha256", authSecret).update(label).digest("base64url");
}

function internalProxyProof(secret: string): string {
  return createHmac("sha256", deriveDomainKey(secret, INTERNAL_PROXY_LABEL))
    .update("quibt-local-browser-proxy-v1")
    .digest("base64url");
}

function attachNovncProxy(server: ViteDevServer | PreviewServer, secret: string) {
  server.middlewares.use((req, res, next) => {
    if (!req.url?.startsWith("/novnc/")) {
      next();
      return;
    }
    const target = resolveNovncTarget(req.url, secret);
    if (!target) {
      res.statusCode = 403;
      res.end("Invalid or expired screen capability");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.end("Method not allowed");
      return;
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
        res.writeHead(incoming.statusCode ?? 502, {
          ...safeProxyResponseHeaders(incoming.headers),
          "access-control-allow-origin": "*",
        });
        incoming.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      res.statusCode = 502;
      res.end(error.message);
    });
    // `req` "close" fires when the GET has been read, not when the browser
    // hangs up — destroying upstream there 502s every embed.html. Tear down
    // only if the client response is abandoned.
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  });

  server.httpServer?.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/novnc/")) return;
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
      socket.pipe(upstream);
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

export default defineConfig(({ command, mode }) => {
  const rootEnv = loadEnv(mode, path.resolve(import.meta.dirname, "../.."), "");
  const api = process.env.API_PROXY_TARGET ?? rootEnv.API_PROXY_TARGET ?? "http://127.0.0.1:3100";
  const authSecret = screenProxySecretFor(command, {
    ...process.env,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? rootEnv.BETTER_AUTH_SECRET,
  });
  // Uma chave por trabalho: a capacidade da tela e a prova de proxy interno saem de
  // chaves derivadas, nunca do segredo de sessão cru. A API deriva as mesmas.
  const screenProxySecret = deriveDomainKey(authSecret, SCREEN_CAPABILITY_LABEL);
  const apiProxy = {
    target: api,
    changeOrigin: true,
    xfwd: true,
    // Overwrite any client-supplied value. The API accepts forwarded localhost
    // claims only when they came through this process and carry this proof.
    headers: {
      "x-quibt-internal-proxy": internalProxyProof(authSecret),
    },
  };
  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "quibt-novnc-proxy",
        configureServer: (server) => attachNovncProxy(server, screenProxySecret),
        configurePreviewServer: (server) => attachNovncProxy(server, screenProxySecret),
      },
    ],
    server: {
      host: "127.0.0.1",
      port: webPort,
      strictPort: true,
      proxy: {
        // `xfwd` manda o host que o navegador realmente usou. Sem ele, `changeOrigin`
        // reescreve o Host para o alvo interno e a API assina a URL da tela como
        // `http://api:5173/novnc/…` — um nome de serviço que só existe dentro do
        // Docker: no navegador e no celular a tela ficava preta.
        "/api": apiProxy,
        "/rpc": apiProxy,
        // Arquivos do fio: upload e download não passam pelo RPC, são bytes.
        "/files": apiProxy,
      },
    },
    preview: {
      host: process.env.WEB_HOST ?? "127.0.0.1",
      port: Number(process.env.WEB_PORT ?? 5173),
      // O nome público (sslip.io ou domínio próprio) chega pelo Caddy; sem isto o
      // preview responde 403 a ele. Ver previewAllowedHosts.
      allowedHosts: previewAllowedHosts({ ...rootEnv, ...process.env }),
      proxy: {
        // `xfwd` manda o host que o navegador realmente usou. Sem ele, `changeOrigin`
        // reescreve o Host para o alvo interno e a API assina a URL da tela como
        // `http://api:5173/novnc/…` — um nome de serviço que só existe dentro do
        // Docker: no navegador e no celular a tela ficava preta.
        "/api": apiProxy,
        "/rpc": apiProxy,
        // Arquivos do fio: upload e download não passam pelo RPC, são bytes.
        "/files": apiProxy,
      },
    },
  };
});
