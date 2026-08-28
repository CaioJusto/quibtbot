import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

const providers = process.argv.includes("--providers");

/**
 * Onde procurar o pnpm, em ordem. `npm_execpath` é o caminho que o próprio pnpm
 * exporta quando ele é quem roda este script: chamá-lo com o Node atual dispensa o
 * PATH e o shim `.cmd` do Windows. Depois vem o PATH e, por último, o corepack.
 */
export function pnpmCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; shell: boolean }[] {
  const candidates: { command: string; args: string[]; shell: boolean }[] = [];
  const execPath = env.npm_execpath;
  if (execPath && /\.[cm]?js$/i.test(execPath)) {
    candidates.push({ command: process.execPath, args: [execPath], shell: false });
  } else if (execPath) {
    candidates.push({ command: execPath, args: [], shell: false });
  }
  const shell = platform === "win32";
  candidates.push({ command: "pnpm", args: [], shell });
  candidates.push({ command: "corepack", args: ["pnpm"], shell });
  return candidates;
}

/** A falha tem de dizer o que aconteceu e o que instalar — nunca sair calada. */
export function missingPnpmMessage(args: string[], error?: Error): string[] {
  return [
    `Não deu para rodar "pnpm ${args.join(" ")}": ${error?.message ?? "erro desconhecido"}`,
    'Instale o pnpm 9 com "npm install -g pnpm@9", ou ligue o corepack com "corepack enable pnpm", e repita.',
  ];
}

/**
 * Chamar o pnpm por execSync dependia do shell achar o binário, e escondia a causa quando não
 * achava. Aqui a ausência do pnpm é dita com todas as letras, e o passo que falhou
 * continua parando a verificação.
 */
function runPnpm(args: string[], options: { cwd?: string } = {}): void {
  let lastError: Error | undefined;
  for (const candidate of pnpmCandidates()) {
    const result = spawnSync(candidate.command, [...candidate.args, ...args], {
      stdio: "inherit",
      env: process.env,
      shell: candidate.shell,
      cwd: options.cwd,
    });
    if (!result.error) {
      if (result.status !== 0) {
        throw new Error(`pnpm ${args.join(" ")} exited ${result.status ?? "sem código"}`);
      }
      return;
    }
    // Só "não achei o executável" merece a próxima tentativa; o resto é falha de verdade.
    if (result.error.code !== "ENOENT")
      throw new Error(missingPnpmMessage(args, result.error).join("\n"));
    lastError = result.error;
  }
  throw new Error(missingPnpmMessage(args, lastError).join("\n"));
}

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

  runPnpm(["--filter", "@quibt/db", "generate"]);
  runPnpm(["--filter", "@quibt/db", "exec", "prisma", "migrate", "deploy"], {
    cwd: path.resolve("packages/db"),
  });

  runPnpm(["verify:fast"]);

  // The PostgreSQL tests intentionally exercise first-owner creation and other
  // durable state. E2E validates a brand-new installation, so it must not inherit
  // whichever valid row the final unit test happened to leave behind. Discard the
  // disposable container and start a second one instead of using a destructive reset.
  await container.stop();
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  databaseUrl = container.getConnectionUri();
  process.env.DATABASE_URL = databaseUrl;
  runPnpm(["--filter", "@quibt/db", "exec", "prisma", "migrate", "deploy"], {
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
    await runPnpmAsync(["--filter", "@quibt/web", "exec", "playwright", "test"], playwrightEnv);
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

/** Igual ao `runPnpm`, para o passo longo (Playwright) que precisa ser assíncrono. */
function runPnpmAsync(args: string[], env: NodeJS.ProcessEnv) {
  const candidates = pnpmCandidates();
  const attempt = (index: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const candidate = candidates[index];
      if (!candidate) {
        reject(new Error(missingPnpmMessage(args).join("\n")));
        return;
      }
      const child = spawn(candidate.command, [...candidate.args, ...args], {
        stdio: "inherit",
        env,
        shell: candidate.shell,
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        // Só "não achei o executável" merece a próxima tentativa.
        if (error.code === "ENOENT" && index + 1 < candidates.length) {
          attempt(index + 1).then(resolve, reject);
          return;
        }
        reject(new Error(missingPnpmMessage(args, error).join("\n")));
      });
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`pnpm ${args.join(" ")} exited ${code}`));
      });
    });
  return attempt(0);
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
