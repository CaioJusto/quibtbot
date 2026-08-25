import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { INSTALL_RELEASE } from "./compose.js";
import { parseComposePsOutput } from "./compose-ps.js";
import { assessComposeServices } from "./compose-services.js";
import type { DockerInvocation } from "./docker-invocation.js";
import { resolveDockerInvocation, runDockerCommand } from "./docker-invocation.js";
import { parseEnvFile } from "./environment.js";
import type { ProcessRunner } from "./orchestrator.js";
import { fetchWithRetry, HTTP_TIMEOUT_MS } from "./orchestrator-helpers.js";
import { diagnoseDataDirectory, diagnoseEnvFilePermissions } from "./permissions.js";
import { redactInstallerText } from "./redact.js";
import { inspectInstallState } from "./state-persist.js";

export interface DoctorCheck {
  ok: boolean;
  message: string;
  detail?: Record<string, unknown>;
}

export interface DoctorReport {
  ok: boolean;
  release: string;
  checks: {
    docker?: DoctorCheck;
    ports?: DoctorCheck;
    permissions?: DoctorCheck;
    manifest?: DoctorCheck;
    health?: DoctorCheck;
  };
}

const REQUIRED_PORTS = [5173, 3100, 5433] as const;

function envFilePath(dataDir: string): string {
  return path.join(path.resolve(dataDir), "quibt.env");
}

function loadEnvValues(dataDir: string): Record<string, string> {
  const target = envFilePath(dataDir);
  if (!existsSync(target)) return {};
  return parseEnvFile(readFileSync(target, "utf8"));
}

function collectSecrets(values: Record<string, string>): string[] {
  return [
    values.BETTER_AUTH_SECRET,
    values.ENCRYPTION_KEY,
    values.SANDBOX_SUPERVISOR_TOKEN,
    values.BOOTSTRAP_SECRET,
    values.DATABASE_PASSWORD,
  ].filter((value): value is string => Boolean(value));
}

function sanitizeCheck(check: DoctorCheck, secrets: string[]): DoctorCheck {
  return {
    ...check,
    message: redactInstallerText(check.message, secrets),
    detail: check.detail
      ? (JSON.parse(redactInstallerText(JSON.stringify(check.detail), secrets)) as Record<
          string,
          unknown
        >)
      : undefined,
  };
}

function apiReadyUrl(envValues: Record<string, string>, publicUrl: string): string {
  const api = envValues.API_URL?.replace(/\/+$/, "");
  if (api) return `${api}/ready`;
  try {
    const origin = new URL(publicUrl);
    origin.port = "3100";
    return `${origin.toString().replace(/\/$/, "")}/ready`;
  } catch {
    return "http://127.0.0.1:3100/ready";
  }
}

export async function probeQuibtServicePort(
  port: number,
  deps: {
    fetch: typeof fetch;
    run?: ProcessRunner;
    composeFile?: string;
    dataDir?: string;
    docker?: DockerInvocation;
  },
): Promise<boolean> {
  if (port === 3100) {
    try {
      const res = await fetchWithRetry(
        "http://127.0.0.1:3100/ready",
        { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) },
        deps.fetch,
        1,
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  if (port === 5173) {
    try {
      const res = await fetchWithRetry(
        "http://127.0.0.1:5173/",
        { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) },
        deps.fetch,
        1,
      );
      return res.status < 500;
    } catch {
      return false;
    }
  }

  if (port === 5433 && deps.run && deps.composeFile && deps.dataDir) {
    const envFile = envFilePath(deps.dataDir);
    const base = ["compose", "-f", deps.composeFile, "--env-file", envFile];
    const docker = deps.docker ?? { command: "docker", prefixArgs: [] };
    const ps = await runDockerCommand(deps.run, docker, [...base, "ps", "--format", "json"]);
    if (ps.code !== 0) return false;
    const parsed = parseComposePsOutput(ps.stdout);
    return assessComposeServices(parsed.rows).ok;
  }

  return false;
}

export async function runDoctor(deps: {
  dataDir: string;
  publicUrl: string;
  composeFile: string;
  run: ProcessRunner;
  fetch: typeof fetch;
  checkPort: (port: number) => Promise<boolean>;
  probeEndpoint?: (port: number) => Promise<boolean>;
  docker?: DockerInvocation;
}): Promise<DoctorReport> {
  const envValues = loadEnvValues(deps.dataDir);
  const secrets = collectSecrets(envValues);
  const envRelease = envValues.QUIBT_STACK_VERSION;
  const release = envRelease && envRelease === INSTALL_RELEASE ? envRelease : INSTALL_RELEASE;
  const stateInspection = inspectInstallState(deps.dataDir);
  const checks: DoctorReport["checks"] = {};
  const probeEndpoint =
    deps.probeEndpoint ??
    ((port: number) =>
      probeQuibtServicePort(port, {
        fetch: deps.fetch,
        run: deps.run,
        composeFile: deps.composeFile,
        dataDir: deps.dataDir,
        docker: deps.docker,
      }));

  const docker =
    deps.docker ??
    (await resolveDockerInvocation(deps.run)) ??
    ({ command: "docker", prefixArgs: [] } satisfies DockerInvocation);

  const dockerVersion = await runDockerCommand(deps.run, docker, ["version", "--format", "json"]);
  if (dockerVersion.code === 0) {
    let parsed: { Server?: { Version?: string } } = {};
    try {
      parsed = JSON.parse(dockerVersion.stdout) as { Server?: { Version?: string } };
    } catch {
      parsed = {};
    }
    checks.docker = sanitizeCheck(
      {
        ok: true,
        message: `Docker ${parsed.Server?.Version ?? "available"}`,
      },
      secrets,
    );
  } else {
    checks.docker = sanitizeCheck(
      {
        ok: false,
        message: redactInstallerText(dockerVersion.stderr || "Docker unavailable", secrets),
      },
      secrets,
    );
  }

  const portResults = await Promise.all(
    REQUIRED_PORTS.map(async (port) => {
      const available = await deps.checkPort(port);
      const responding = available ? false : await probeEndpoint(port);
      return { port, available, inUseByQuibt: !available && responding };
    }),
  );
  const blocked = portResults.filter((entry) => !entry.available && !entry.inUseByQuibt);
  checks.ports = sanitizeCheck(
    {
      ok: blocked.length === 0,
      message:
        blocked.length === 0
          ? "Required local ports are available or already serving Quibt"
          : `Local ports blocked: ${blocked.map((entry) => entry.port).join(", ")}`,
      detail: { ports: portResults, scope: "local-loopback" },
    },
    secrets,
  );

  const envFile = envFilePath(deps.dataDir);
  const dataDirCheck = diagnoseDataDirectory(deps.dataDir);
  const envCheck = diagnoseEnvFilePermissions(envFile);
  const permissionsOk = dataDirCheck.ok && envCheck.ok;
  const permissionsMessage = !dataDirCheck.ok
    ? dataDirCheck.message
    : !envCheck.ok
      ? envCheck.message
      : "Install data directory is writable and environment file permissions are 0600";

  checks.permissions = sanitizeCheck({ ok: permissionsOk, message: permissionsMessage }, secrets);

  const manifestOk = existsSync(deps.composeFile);
  const releaseMismatch =
    envRelease && envRelease !== INSTALL_RELEASE
      ? `Environment release ${envRelease} does not match embedded installer release ${INSTALL_RELEASE}.`
      : null;
  const stateIssue =
    !stateInspection.ok && stateInspection.reason === "update_required"
      ? stateInspection.message
      : !stateInspection.ok && stateInspection.reason === "corrupt"
        ? stateInspection.message
        : null;
  checks.manifest = sanitizeCheck(
    {
      ok: manifestOk && !releaseMismatch && !stateIssue,
      message: !manifestOk
        ? "Compose manifest is missing"
        : (releaseMismatch ?? stateIssue ?? `Manifest present for embedded release ${release}`),
      detail: {
        composeFile: deps.composeFile,
        release,
        releaseMismatch,
        stateIssue,
      },
    },
    secrets,
  );

  const envFileForCompose = envFilePath(deps.dataDir);
  const base = ["compose", "-f", deps.composeFile, "--env-file", envFileForCompose];
  const ps = await runDockerCommand(deps.run, docker, [...base, "ps", "--format", "json"]);
  const parsedPs = parseComposePsOutput(ps.stdout);
  const serviceAssessment = assessComposeServices(parsedPs.rows);
  const servicesHealthy = ps.code === 0 && serviceAssessment.ok;

  const readyUrl = apiReadyUrl(envValues, deps.publicUrl);
  let apiHealthy = false;
  try {
    const res = await fetchWithRetry(
      readyUrl,
      { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) },
      deps.fetch,
    );
    apiHealthy = res.ok;
  } catch {
    apiHealthy = false;
  }

  checks.health = sanitizeCheck(
    {
      ok: servicesHealthy && apiHealthy,
      message:
        servicesHealthy && apiHealthy
          ? "All essential services and API /ready are healthy"
          : !servicesHealthy
            ? serviceAssessment.message
            : "Essential services are running but API /ready is not healthy",
      detail: {
        readyUrl,
        servicesHealthy,
        apiHealthy,
        missingServices: serviceAssessment.missing,
        notRunningServices: serviceAssessment.notRunning,
        unhealthyServices: serviceAssessment.unhealthy,
        composePsErrors: parsedPs.errors,
        scope: "local",
      },
    },
    secrets,
  );

  const ok = Object.values(checks).every((check) => check?.ok);
  return { ok, release, checks };
}

export async function defaultCheckPort(port: number): Promise<boolean> {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code !== "EADDRINUSE");
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}
