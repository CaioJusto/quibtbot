import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  allQuibtImages,
  apiReadyUrl,
  createProcessRunner,
  ensureInstallEnvironment,
  finalizePairingInstall,
  INSTALL_RELEASE,
  type InstallerEvent,
  type InstallResult,
  runInstall,
} from "@quibt/installer";
import { readComposeFile } from "./compose-config.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const COMPOSE_FILE = path.join(REPO_ROOT, "infra/compose/docker-compose.desktop.yml");
const PUBLIC_URL = "http://127.0.0.1:5173";

export interface InstallerSmokeResult {
  release: string;
  envValues: Record<string, string>;
  resolvedImages: string[];
  commandOrder: string[];
  readyUrl: string;
  readyProbes: string[];
  envMtimeUnchanged: boolean;
  dockerCommandsOnRerun: string[];
  events: InstallerEvent[];
  first: InstallResult;
  second: InstallResult;
  failedStep?: string;
  failureMessage?: string;
}

type FakeDockerOptions = {
  failPull?: boolean;
  failPullMessage?: string;
};

function writeFakeDocker(
  binDir: string,
  options: FakeDockerOptions = {},
): {
  dockerPath: string;
  logPath: string;
} {
  const logPath = path.join(binDir, "commands.log");
  const dockerPath = path.join(binDir, "docker");
  const failPull = options.failPull ? "1" : "";
  const failPullMessage =
    options.failPullMessage ?? "pull failed: DATABASE_PASSWORD=secret123 BOOTSTRAP_SECRET=abc123";

  writeFileSync(
    dockerPath,
    `#!/bin/sh
LOG="${logPath}"
echo "$@" >> "$LOG"
case "$1" in
  info)
    exit 0
    ;;
  pull)
    if [ -n "${failPull}" ]; then
      echo "${failPullMessage}" >&2
      exit 1
    fi
    echo "aaaaaaaaaaaa: Pulling fs layer"
    echo "aaaaaaaaaaaa: Pull complete"
    exit 0
    ;;
  compose)
    args="$*"
    case "$args" in
      *" config --images"*)
        echo "postgres:16@sha256:e17e86066e5ef83e0952a9347f5c792b7ece00972e2aa787a6986f471b3dd3d5"
        echo "ghcr.io/quibt/quibt-computer:${INSTALL_RELEASE}"
        echo "ghcr.io/quibt/quibt-supervisor:${INSTALL_RELEASE}"
        echo "ghcr.io/quibt/quibt-stack:${INSTALL_RELEASE}"
        exit 0
        ;;
      *" pull"*)
        if [ -n "${failPull}" ]; then
          echo "${failPullMessage}" >&2
          exit 1
        fi
        exit 0
        ;;
      *" run --rm"*"quibt-migrate"*)
        exit 0
        ;;
      *" up"*)
        exit 0
        ;;
      *)
        echo "fake docker: unknown compose invocation: $args" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "fake docker: unknown command: $1" >&2
    exit 1
    ;;
esac
`,
    { mode: 0o755 },
  );
  chmodSync(dockerPath, 0o755);
  return { dockerPath, logPath };
}

function readDockerLog(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
}

function classifyComposeCommand(line: string): string | null {
  // O download é uma imagem por vez (`docker pull <ref>`), com progresso por camada.
  if (line.startsWith("pull ")) return "image pull";
  if (!line.startsWith("compose ")) return null;
  if (line.includes(" config --images")) return null;
  if (line.includes(" pull")) return "compose pull";
  if (line.includes(" run --rm") && line.includes("quibt-migrate")) return "compose run migrate";
  if (line.includes(" up ") && line.includes(" postgres")) return "compose up postgres";
  if (
    line.includes(" up ") &&
    (line.includes(" supervisor") ||
      line.includes(" api") ||
      line.includes(" worker") ||
      line.includes(" web") ||
      line.includes(" computer"))
  ) {
    return "compose up apps";
  }
  return null;
}

function commandOrderFromLog(logPath: string): string[] {
  const order: string[] = [];
  for (const line of readDockerLog(logPath)) {
    const kind = classifyComposeCommand(line);
    if (kind && order[order.length - 1] !== kind) {
      order.push(kind);
    }
  }
  return order;
}

function createSmokeFetch(readyProbes: string[]) {
  const minted = {
    code: "SMOKETEST",
    token: "smoke-invite-token",
    expiresAt: "2026-08-17T01:00:00.000Z",
  };

  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/ready")) {
      readyProbes.push(url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.endsWith("/api/bootstrap/invites") && init?.method === "POST") {
      return new Response(JSON.stringify(minted), { status: 200 });
    }
    if (url.endsWith("/rpc/health") && init?.method === "POST") {
      return new Response(JSON.stringify({ json: { ok: true, needsFirstOwner: true } }), {
        status: 200,
      });
    }
    return new Response("not found", { status: 404 });
  };
}

async function runSmokeInstall(
  dataDir: string,
  dockerPath: string,
): Promise<{
  result: InstallResult;
  events: InstallerEvent[];
  readyProbes: string[];
  envValues: Record<string, string>;
}> {
  const readyProbes: string[] = [];
  const events: InstallerEvent[] = [];
  const clock = {
    now: () => new Date("2026-08-17T00:30:00.000Z"),
    sleep: async () => undefined,
  };

  const result = await runInstall({
    dataDir,
    publicUrl: PUBLIC_URL,
    composeFile: COMPOSE_FILE,
    composeMode: "packaged",
    run: createProcessRunner(),
    fetch: createSmokeFetch(readyProbes),
    clock,
    platform: "linux",
    docker: { command: dockerPath, prefixArgs: [] },
    // A suíte não pode depender do disco livre de quem a roda.
    statfs: async () => ({ bsize: 4096, bavail: 25_000_000 }),
    onEvent: (event) => events.push(event),
  });

  const env = ensureInstallEnvironment(dataDir, PUBLIC_URL);
  return { result, events, readyProbes, envValues: env.values };
}

export async function probeFakeDockerStrictness(): Promise<{
  unknownComposeCode: number;
  unknownTopLevelCode: number;
}> {
  const binDir = mkdtempSync(path.join(tmpdir(), "quibt-fake-docker-strict-"));
  try {
    const { dockerPath } = writeFakeDocker(binDir);
    const run = createProcessRunner();
    const unknownCompose = await run.run(dockerPath, ["compose", "-f", "x.yml", "ps"]);
    const unknownTopLevel = await run.run(dockerPath, ["volume", "ls"]);
    return {
      unknownComposeCode: unknownCompose.code,
      unknownTopLevelCode: unknownTopLevel.code,
    };
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}

export async function runInstallerSmokeJourney(): Promise<InstallerSmokeResult> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-installer-smoke-"));
  const binDir = mkdtempSync(path.join(tmpdir(), "quibt-fake-docker-bin-"));
  const { dockerPath, logPath } = writeFakeDocker(binDir);

  try {
    const first = await runSmokeInstall(dataDir, dockerPath);
    const envMtimeBeforeRerun = statSync(path.join(dataDir, "quibt.env")).mtimeMs;

    await finalizePairingInstall(dataDir, {
      now: () => new Date("2026-08-17T00:31:00.000Z"),
      sleep: async () => undefined,
    });

    const logBeforeRerun = readDockerLog(logPath).length;
    const second = await runSmokeInstall(dataDir, dockerPath);
    const envMtimeAfterRerun = statSync(path.join(dataDir, "quibt.env")).mtimeMs;
    const dockerCommandsOnRerun = readDockerLog(logPath).slice(logBeforeRerun);

    const manifest = readComposeFile(COMPOSE_FILE);
    const readyUrl = apiReadyUrl(first.envValues, PUBLIC_URL);

    return {
      release: INSTALL_RELEASE,
      envValues: first.envValues,
      resolvedImages: allQuibtImages(manifest),
      commandOrder: commandOrderFromLog(logPath),
      readyUrl,
      readyProbes: first.readyProbes,
      envMtimeUnchanged: envMtimeAfterRerun === envMtimeBeforeRerun,
      dockerCommandsOnRerun,
      events: [...first.events, ...second.events],
      first: first.result,
      second: second.result,
    };
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
}

export async function runInstallerSmokeSanitizedFailure(): Promise<InstallerSmokeResult> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-installer-smoke-fail-"));
  const binDir = mkdtempSync(path.join(tmpdir(), "quibt-fake-docker-bin-"));
  const env = ensureInstallEnvironment(dataDir, PUBLIC_URL);
  const failMessage = `pull failed: DATABASE_PASSWORD=${env.values.DATABASE_PASSWORD} BOOTSTRAP_SECRET=${env.values.BOOTSTRAP_SECRET}`;
  const { dockerPath, logPath } = writeFakeDocker(binDir, {
    failPull: true,
    failPullMessage: failMessage,
  });

  try {
    const first = await runSmokeInstall(dataDir, dockerPath);
    const failedEvent = first.events.find((event) => event.status === "failed");

    return {
      release: INSTALL_RELEASE,
      envValues: first.envValues,
      resolvedImages: allQuibtImages(readComposeFile(COMPOSE_FILE)),
      commandOrder: commandOrderFromLog(logPath),
      readyUrl: apiReadyUrl(first.envValues, PUBLIC_URL),
      readyProbes: first.readyProbes,
      envMtimeUnchanged: true,
      dockerCommandsOnRerun: [],
      events: first.events,
      first: first.result,
      second: first.result,
      failedStep: failedEvent?.step,
      // A frase do evento é para gente; o stderr cru (já sem segredos) vai em `detail`.
      failureMessage: failedEvent
        ? [failedEvent.message, (failedEvent.detail as { stderr?: string } | undefined)?.stderr]
            .filter(Boolean)
            .join("\n")
        : first.result.error,
    };
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
}

export function validateDesktopComposeConfig(rootDir = REPO_ROOT): void {
  const composeFile = path.join(rootDir, "infra/compose/docker-compose.desktop.yml");
  const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-smoke-compose-data-"));
  let projectDir: string | undefined;

  try {
    const envFile = path.join(dataDir, "quibt.env");
    writeFileSync(
      envFile,
      [
        "DATABASE_PASSWORD=smoke-test-password",
        `DATA_DIR=${dataDir}`,
        `QUIBT_STACK_VERSION=${INSTALL_RELEASE}`,
        `INSTALL_ENV_FILE=${envFile}`,
        "BETTER_AUTH_SECRET=smoke-test-secret",
        "WEB_ORIGIN=http://127.0.0.1:5173",
        "BETTER_AUTH_URL=http://127.0.0.1:5173",
      ].join("\n"),
      { mode: 0o600 },
    );

    projectDir = mkdtempSync(path.join(tmpdir(), "quibt-smoke-compose-project-"));
    mkdirSync(path.join(projectDir, "infra", "compose"), { recursive: true });
    const target = path.join(projectDir, "infra", "compose", path.basename(composeFile));
    copyFileSync(composeFile, target);

    execFileSync(
      "docker",
      [
        "compose",
        "-f",
        path.relative(projectDir, target),
        "--env-file",
        envFile,
        "config",
        "--format",
        "json",
      ],
      {
        cwd: projectDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 20_000,
      },
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  }
}

export function isDockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function runInstallerSmokeCli(): Promise<void> {
  await runInstallerSmokeJourney();
  await runInstallerSmokeSanitizedFailure();
  if (isDockerAvailable()) {
    validateDesktopComposeConfig();
    console.log("installer smoke: fake docker journey ok");
    console.log("installer smoke: docker compose config ok");
  } else {
    console.log("installer smoke: fake docker journey ok");
    console.log("installer smoke: docker compose config skipped (docker unavailable)");
  }
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runInstallerSmokeCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
