import { loadRootEnv } from "./load-root-env.js";

loadRootEnv();

import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const { app } = await createApp(env);
const server = serve({ fetch: app.fetch, port: env.port }, () => {
  console.log(`Quibt API on http://127.0.0.1:${env.port}`);
}) as Server;
server.requestTimeout = 30_000;
server.headersTimeout = 12_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;
