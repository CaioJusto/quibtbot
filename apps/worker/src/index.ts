import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";

function loadRootEnv() {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) {
      config({ path: candidate, override: false });
      if (process.env.DATA_DIR && !path.isAbsolute(process.env.DATA_DIR)) {
        process.env.DATA_DIR = path.resolve(dir, process.env.DATA_DIR);
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  config();
}
loadRootEnv();

import {
  createConnectorStack,
  createRoutingSandboxProvider,
  createRunExecutor,
  EncryptedSecretStore,
  ExpoPushProvider,
  GraphileWakeupDriver,
  InMemoryWakeupDriver,
  isComposioEnabled,
  LocalAgentHomeStore,
  loadFolderGrantsByUser,
  PiAgentRuntime,
  ScriptedAgentRuntime,
  sandboxOptionsFromSettings,
  scheduleOrphanReconcile,
  scheduleRunReap,
  storedComposioKeyLoader,
} from "@quibt/adapters";
import { editionGate, resolveEncryptionKey } from "@quibt/core";
import { assertWorkspaceWithinPlan, createDb } from "@quibt/db";
import { MarkdownMemoryStore } from "@quibt/memory";
import { sandboxOptionsFromEnv, workerBillingEnabled, workerRuntimeConfig } from "./config.js";
import { createWakeupHandlers } from "./handlers.js";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const { prisma } = createDb(databaseUrl);
  const runtime =
    process.env.AGENT_RUNTIME === "scripted" ? new ScriptedAgentRuntime() : new PiAgentRuntime();
  const dataDir = process.env.DATA_DIR ?? "./data";
  const desktopGrantsByUser = await loadFolderGrantsByUser(dataDir);
  const runtimeConfig = workerRuntimeConfig(process.env);
  const secrets = new EncryptedSecretStore(resolveEncryptionKey(process.env));
  const sandboxOptions = sandboxOptionsFromEnv(process.env, dataDir, desktopGrantsByUser);
  // Same routing rule as the API: the deployment's saved machine wins, `SANDBOX_PROVIDER` is the
  // fallback. Without this the worker would keep booting bots on a machine nobody chose.
  const sandbox = createRoutingSandboxProvider({
    fallbackKind: runtimeConfig.sandboxProvider,
    options: sandboxOptions,
    readSelection: async () => ({
      saved: (
        await prisma.deploymentSettings.findUnique({
          where: { id: "default" },
          select: { sandboxProvider: true },
        })
      )?.sandboxProvider,
      canChooseMachine: editionGate({
        edition: runtimeConfig.edition,
        billingEnabled: runtimeConfig.billingEnabled,
      }).canChooseMachine,
    }),
    readOptions: async () =>
      sandboxOptionsFromSettings(
        await prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
        secrets,
        sandboxOptions,
      ),
    readComputerKind: async (botId) =>
      (
        await prisma.desktopSession.findUnique({
          where: { botId },
          select: { computer: { select: { kind: true } } },
        })
      )?.computer.kind ?? null,
    onError: (error) => console.error("sandbox routing", error),
  });
  const stack = createConnectorStack({
    envApiKey: isComposioEnabled(process.env.COMPOSIO_API_KEY)
      ? process.env.COMPOSIO_API_KEY
      : undefined,
    loadStoredKey: storedComposioKeyLoader(prisma, secrets),
  });
  const connector = stack.destination;
  await connector.start();
  const wakeup =
    process.env.WAKEUP_DRIVER === "memory"
      ? new InMemoryWakeupDriver()
      : new GraphileWakeupDriver(databaseUrl);
  const executor = createRunExecutor({
    prisma,
    runtime,
    sandbox,
    memory: new MarkdownMemoryStore(prisma),
    home: new LocalAgentHomeStore(dataDir),
    connector: stack.connector,
    secrets: [process.env.OPENROUTER_API_KEY ?? "", process.env.COMPOSIO_API_KEY ?? ""].filter(
      Boolean,
    ),
    secretStore: secrets,
    deploymentModelKey: process.env.OPENROUTER_API_KEY,
    dataDir,
    notifications: new ExpoPushProvider(prisma),
    wakeup,
    billing: workerBillingEnabled(process.env)
      ? {
          assertWithinPlan: (workspaceId, check, tx) =>
            assertWorkspaceWithinPlan(tx ?? prisma, workspaceId, check),
        }
      : undefined,
  });

  await wakeup.start(
    createWakeupHandlers({
      prisma,
      sandbox,
      wakeup,
      executor,
      home: new LocalAgentHomeStore(dataDir),
      dataDir,
    }),
  );
  // Starts the reaper loop; it reschedules itself under a single job key.
  scheduleRunReap(wakeup, 0);
  scheduleOrphanReconcile(wakeup, 0);

  console.log("quibt worker ready");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
