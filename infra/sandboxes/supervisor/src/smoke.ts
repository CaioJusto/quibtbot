/**
 * Real-Docker smoke test for the sandbox supervisor.
 *
 * `pnpm verify:fast` pins `SANDBOX_PROVIDER=fake`, so nothing in the default suite ever
 * talks to a Docker daemon: the provider a self-hosted install actually runs was only
 * covered by hand. This script drives the supervisor over HTTP exactly like
 * `DockerSandboxProvider` does — provision, exec, screen, destroy — and fails loudly when
 * stdout, stderr, the exit code, or container cleanup regress.
 *
 * CI runs it in the `docker-smoke` job; locally:
 *   pnpm sandbox:build
 *   SANDBOX_SUPERVISOR_TOKEN=<32+ chars> pnpm --filter @quibt/sandbox-supervisor start &
 *   SANDBOX_SUPERVISOR_TOKEN=<same> pnpm exec tsx infra/sandboxes/supervisor/src/smoke.ts
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveSupervisorToken } from "@quibt/core";

const run = promisify(execFile);

export interface SmokeExec {
  stdout: string;
  stderr: string;
  code: number;
}

/** Exit code the smoke command returns: not 0 and not 1, so a swallowed status shows up. */
export const SMOKE_EXIT_CODE = 7;

/**
 * One command that writes to both streams and fails on purpose. The Docker provider used
 * to merge the two frames and to report `code: 0`, so the smoke has to read all three.
 */
export function smokeCommand(marker: string): string[] {
  return [
    "bash",
    "-lc",
    `echo ${marker}-stdout; echo ${marker}-stderr 1>&2; exit ${SMOKE_EXIT_CODE}`,
  ];
}

/** Returns one line per broken expectation; an empty array means the smoke passed. */
export function checkSmokeExec(result: SmokeExec, marker: string): string[] {
  const problems: string[] = [];
  if (!result.stdout.includes(`${marker}-stdout`)) {
    problems.push(`stdout lost the command output (got ${JSON.stringify(result.stdout)})`);
  }
  if (!result.stderr.includes(`${marker}-stderr`)) {
    problems.push(`stderr lost the command output (got ${JSON.stringify(result.stderr)})`);
  }
  if (result.stdout.includes(`${marker}-stderr`)) {
    problems.push("stderr was merged into stdout");
  }
  if (result.code !== SMOKE_EXIT_CODE) {
    problems.push(`exit code ${result.code} instead of ${SMOKE_EXIT_CODE}`);
  }
  return problems;
}

/** The supervisor answers 403 without both identity headers, so they are never optional. */
export function smokeHeaders(token: string, botId: string, workspaceId: string) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-quibt-bot-id": botId,
    "x-quibt-workspace-id": workspaceId,
  };
}

/** `docker ps -a` output for the workspace label; anything left behind is an orphan. */
export function orphanContainers(dockerPsOutput: string): string[] {
  return dockerPsOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export interface SmokeOptions {
  supervisorUrl: string;
  token: string;
  workspaceId: string;
  botId: string;
  log?: (message: string) => void;
  timeoutMs?: number;
  /** Injected by the unit test; production uses the global fetch and the docker CLI. */
  fetchImpl?: typeof fetch;
  listWorkspaceContainers?: (workspaceId: string) => Promise<string>;
}

export async function runDockerSmoke(options: SmokeOptions): Promise<void> {
  const log = options.log ?? ((message: string) => console.log(`[docker-smoke] ${message}`));
  const call = options.fetchImpl ?? fetch;
  const listContainers = options.listWorkspaceContainers ?? dockerWorkspaceContainers;
  const base = options.supervisorUrl.replace(/\/$/, "");
  const headers = smokeHeaders(options.token, options.botId, options.workspaceId);
  const marker = `smoke-${Date.now()}`;

  const health = await waitFor(
    async () => {
      const response = await call(`${base}/health`);
      return response.ok ? ((await response.json()) as { image?: string }) : undefined;
    },
    options.timeoutMs ?? 60_000,
    "supervisor /health never answered",
  );
  log(`supervisor is up (image ${health.image})`);

  const provision = await call(`${base}/computers`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      botId: options.botId,
      homePath: `/home/${options.botId}`,
      workspaceId: options.workspaceId,
    }),
  });
  if (!provision.ok) {
    throw new Error(`provision failed: ${provision.status} ${await provision.text()}`);
  }
  const computer = (await provision.json()) as { id: string; screenUrl: string; display: number };
  log(`provisioned ${computer.id.slice(0, 12)} on display ${computer.display}`);

  try {
    const exec = await call(`${base}/computers/${computer.id}/exec`, {
      method: "POST",
      headers,
      body: JSON.stringify({ argv: smokeCommand(marker) }),
    });
    if (!exec.ok) throw new Error(`exec failed: ${exec.status} ${await exec.text()}`);
    const result = (await exec.json()) as SmokeExec;
    const problems = checkSmokeExec(result, marker);
    if (problems.length) throw new Error(`exec contract broken:\n- ${problems.join("\n- ")}`);
    log(`exec kept stdout, stderr, and exit code ${result.code}`);

    await waitFor(
      async () => {
        const screen = await call(computer.screenUrl).catch(() => undefined);
        return screen?.ok ? true : undefined;
      },
      options.timeoutMs ?? 60_000,
      `the graphical session never served ${computer.screenUrl}`,
    );
    log(`screen answers on ${computer.screenUrl}`);
  } finally {
    const destroy = await call(`${base}/computers/${computer.id}`, { method: "DELETE", headers });
    log(`destroy returned ${destroy.status}`);
  }

  const inspect = await call(`${base}/computers/${computer.id}`, { headers });
  if (inspect.status !== 404) {
    throw new Error(`destroyed computer still answers with ${inspect.status}`);
  }
  const orphans = orphanContainers(await listContainers(options.workspaceId));
  if (orphans.length) throw new Error(`orphan containers left behind: ${orphans.join(", ")}`);
  log("no orphan container left behind");
}

async function dockerWorkspaceContainers(workspaceId: string): Promise<string> {
  const listed = await run("docker", [
    "ps",
    "-a",
    "--filter",
    `label=quibt.workspaceId=${workspaceId}`,
    "--format",
    "{{.Names}} {{.Status}}",
  ]);
  return listed.stdout;
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs: number, message: string) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(lastError ? `${message} (${String(lastError)})` : message);
}

const entry = process.argv[1];
if (entry && path.resolve(entry) === fileURLToPath(import.meta.url)) void main();

async function main() {
  const stamp = Date.now().toString(36);
  try {
    await runDockerSmoke({
      supervisorUrl: process.env.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091",
      token: resolveSupervisorToken(process.env),
      workspaceId: process.env.SMOKE_WORKSPACE_ID ?? `smoke${stamp}`,
      botId: process.env.SMOKE_BOT_ID ?? `smokebot${stamp}`,
    });
    console.log("[docker-smoke] ok");
  } catch (error) {
    console.error("[docker-smoke] FAILED", error);
    process.exit(1);
  }
}
