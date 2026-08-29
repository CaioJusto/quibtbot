import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type PreviewServer, type ViteDevServer } from "vite";
import { previewAllowedHosts, screenProxySecretFor } from "./src/build-config.js";
import { attachNovncUpgrade, proxyNovncHttp } from "./src/node-screen-proxy.js";
import { internalProxyProof, screenProxySecret } from "./src/server-keys.js";

const webPort = Number(process.env.WEB_PORT ?? 5173);

function attachNovncProxy(server: ViteDevServer | PreviewServer, secret: string) {
  server.middlewares.use((req, res, next) => {
    if (!proxyNovncHttp(req, res, secret)) next();
  });
  if (server.httpServer) attachNovncUpgrade(server.httpServer, secret);
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
  const screenCapabilitySecret = screenProxySecret(authSecret);
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
        configureServer: (server) => attachNovncProxy(server, screenCapabilitySecret),
        configurePreviewServer: (server) => attachNovncProxy(server, screenCapabilitySecret),
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
