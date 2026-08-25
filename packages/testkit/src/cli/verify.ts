import { execFileSync, execSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

const providers = process.argv.includes("--providers");

async function main() {
  configureContainerRuntime();
  const reportDir = path.resolve("verify-report");
  await mkdir(reportDir, { recursive: true });
  let container = await new PostgreSqlContainer("postgres:16-alpine").start();
  let databaseUrl = container.getConnectionUri();
  const apiPort = Number(process.env.API_PORT ?? 3110);
  const webPort = Number(process.env.WEB_PORT ?? 5180);
  const webOrigin = `http://127.0.0.1:${webPort}`;

  process.env.DATABASE_URL = databaseUrl;
  process.env.WAKEUP_DRIVER = "memory";
  process.env.SANDBOX_PROVIDER = "fake";
  process.env.AGENT_RUNTIME = "scripted";
  if (providers) {
    process.env.VERIFY_PROVIDERS = "1";
    if (process.env.E2B_API_KEY) process.env.SANDBOX_PROVIDER = "e2b";
    if (process.env.OPENROUTER_API_KEY) process.env.AGENT_RUNTIME = "pi";
  }
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64url");
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64url");
  process.env.SANDBOX_SUPERVISOR_TOKEN = randomBytes(32).toString("base64url");
  process.env.BOOTSTRAP_SECRET = randomBytes(32).toString("base64url");
  process.env.BETTER_AUTH_URL = webOrigin;
  process.env.WEB_ORIGIN = webOrigin;
  process.env.API_PORT = String(apiPort);
  process.env.API_URL = `http://127.0.0.1:${apiPort}`;
  process.env.API_PROXY_TARGET = `http://127.0.0.1:${apiPort}`;
  process.env.WEB_PORT = String(webPort);
  process.env.PLAYWRIGHT_BASE_URL = webOrigin;
  process.env.DATA_DIR = path.join(reportDir, "data");
  process.env.SIGNUPS_ENABLED = "true";
  process.env.CI = "1";

  execSync("pnpm --filter @quibt/db generate", { stdio: "inherit", env: process.env });
  execSync("pnpm --filter @quibt/db exec prisma migrate deploy", {
    stdio: "inherit",
    env: process.env,
    cwd: path.resolve("packages/db"),
  });

  execSync("pnpm verify:fast", { stdio: "inherit", env: process.env });

  // The PostgreSQL tests intentionally exercise first-owner creation and other
  // durable state. E2E validates a brand-new installation, so it must not inherit
  // whichever valid row the final unit test happened to leave behind. Discard the
  // disposable container and start a second one instead of using a destructive reset.
  await container.stop();
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  databaseUrl = container.getConnectionUri();
  process.env.DATABASE_URL = databaseUrl;
  execSync("pnpm --filter @quibt/db exec prisma migrate deploy", {
    stdio: "inherit",
    env: process.env,
    cwd: path.resolve("packages/db"),
  });

  const { createApp } = await import("../../../../apps/api/src/app.ts");
  const { serve } = await import("@hono/node-server");
  const handles = await createApp({ databaseUrl, prisma: undefined });
  const server = serve({ fetch: handles.app.fetch, port: apiPort, hostname: "127.0.0.1" });
  await waitForHealth(`http://127.0.0.1:${apiPort}/health`, 15_000);

  try {
    const playwrightEnv = {
      ...process.env,
      CI: "1",
    };
    delete playwrightEnv.NO_COLOR;
    await run("pnpm", ["--filter", "@quibt/web", "exec", "playwright", "test"], playwrightEnv);
    await writeFile(
      path.join(reportDir, "summary.json"),
      JSON.stringify(
        {
          ok: true,
          providers,
          sandbox: process.env.SANDBOX_PROVIDER,
          runtime: process.env.AGENT_RUNTIME,
          apiPort,
          webPort,
          at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } finally {
    server.close();
    await handles.stop().catch(() => undefined);
    await container.stop().catch(() => undefined);
  }
}

function configureContainerRuntime() {
  if (process.env.DOCKER_HOST) return;
  try {
    const dockerHost = execFileSync(
      "docker",
      ["context", "inspect", "--format", "{{ .Endpoints.docker.Host }}"],
      { encoding: "utf8" },
    ).trim();
    if (!dockerHost) return;
    process.env.DOCKER_HOST = dockerHost;
    if (dockerHost.includes("/.colima/")) {
      process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE ??= "/var/run/docker.sock";
    }
  } catch {
    // Testcontainers will produce its normal runtime discovery error below.
  }
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env, shell: false });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

async function waitForHealth(url: string, ms: number) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`API health check failed for ${url}: ${last}`);
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
