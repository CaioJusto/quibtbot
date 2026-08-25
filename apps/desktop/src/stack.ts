import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ComposeMode } from "@quibt/installer";
import { COMPOSE_MANIFEST_NAME } from "@quibt/installer";

export type StackResolutionMode = "source-build" | "packaged-images" | "remote";

export interface StackPaths {
  userData: string;
  appPath: string;
  resourcesPath?: string;
  isPackaged?: boolean;
  webUrl?: string;
  composeFileOverride?: string;
}

export function resolveComposeOverride(
  override: string | undefined,
): { ok: true; path: string } | { ok: false; message: string } {
  const trimmed = override?.trim();
  if (!trimmed) return { ok: false, message: "missing override" };
  const resolved = path.resolve(trimmed);
  if (!existsSync(resolved)) {
    return {
      ok: false,
      message: `QUIBT_COMPOSE_FILE points to a missing file: ${resolved}`,
    };
  }
  return { ok: true, path: resolved };
}

export interface StackResolution {
  mode: StackResolutionMode;
  composeFile: string | null;
  dataDir: string;
  error?: string;
}

export function packagedComposeFile(resourcesPath: string): string | null {
  const candidate = path.join(resourcesPath, "compose", COMPOSE_MANIFEST_NAME);
  return existsSync(candidate) ? candidate : null;
}

export function findComposeFile(paths: StackPaths): string | null {
  const candidates = [
    path.join(paths.appPath, "infra", "compose", "docker-compose.yml"),
    path.join(paths.appPath, "..", "..", "infra", "compose", "docker-compose.yml"),
    path.join(paths.appPath, "..", "infra", "compose", "docker-compose.yml"),
    paths.resourcesPath ? path.join(paths.resourcesPath, "compose", "docker-compose.yml") : "",
  ].filter(Boolean);
  const existing = candidates.filter((file) => existsSync(file));
  return existing.find((file) => isBuildableCompose(file)) ?? existing[0] ?? null;
}

/** Compose builds from the monorepo. A lone bundled YAML cannot `--build`. */
export function isBuildableCompose(composeFile: string): boolean {
  const dir = path.dirname(composeFile);
  return (
    existsSync(path.join(dir, "Dockerfile")) &&
    existsSync(path.resolve(dir, "..", "..", "package.json"))
  );
}

export function resolveStack(paths: StackPaths): StackResolution {
  const dataDir = path.resolve(paths.userData);
  const webUrl = paths.webUrl ?? "http://127.0.0.1:5173";

  const override = resolveComposeOverride(
    paths.composeFileOverride ?? process.env.QUIBT_COMPOSE_FILE,
  );
  if (override.ok) {
    const mode = isBuildableCompose(override.path) ? "source-build" : "packaged-images";
    return { mode, composeFile: override.path, dataDir };
  }
  if (paths.composeFileOverride ?? process.env.QUIBT_COMPOSE_FILE?.trim()) {
    return {
      mode: "packaged-images",
      composeFile: null,
      dataDir,
      error: override.ok ? undefined : override.message,
    };
  }

  if (!isLocalWebUrl(webUrl)) {
    return { mode: "remote", composeFile: null, dataDir };
  }

  const sourceCompose = findComposeFile({ ...paths, userData: dataDir });
  if (sourceCompose && isBuildableCompose(sourceCompose)) {
    return { mode: "source-build", composeFile: sourceCompose, dataDir };
  }

  if (paths.resourcesPath) {
    const packagedCompose = packagedComposeFile(paths.resourcesPath);
    if (packagedCompose) {
      return { mode: "packaged-images", composeFile: packagedCompose, dataDir };
    }
  }

  if (paths.isPackaged) {
    return { mode: "packaged-images", composeFile: null, dataDir };
  }

  if (sourceCompose) {
    return { mode: "source-build", composeFile: sourceCompose, dataDir };
  }

  return { mode: "source-build", composeFile: null, dataDir };
}

export function toComposeMode(mode: StackResolutionMode): ComposeMode | null {
  if (mode === "source-build") return "source";
  if (mode === "packaged-images") return "packaged";
  return null;
}

export function localApiReadyUrl(webUrl: string): string | null {
  try {
    const url = new URL(webUrl);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      return `${url.protocol}//${url.hostname}:3100/ready`;
    }
  } catch {
    return null;
  }
  return null;
}

export function isLocalWebUrl(webUrl: string): boolean {
  try {
    const url = new URL(webUrl);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return false;
  }
}

export function envFilePath(userData: string) {
  return path.join(userData, "quibt.env");
}

export function randomSecret(): string {
  return randomBytes(32).toString("hex");
}

export function ensureDesktopEnv(userData: string): { path: string; created: boolean } {
  mkdirSync(userData, { recursive: true });
  const target = envFilePath(userData);
  if (existsSync(target)) return { path: target, created: false };
  const secret = randomSecret();
  const encryption = randomSecret();
  const supervisor = randomSecret();
  writeFileSync(
    target,
    [
      "QUIBT_EDITION=oss",
      "BILLING_ENABLED=false",
      "AUTH_EMAIL_DISABLED=true",
      `BETTER_AUTH_SECRET=${secret}`,
      `ENCRYPTION_KEY=${encryption}`,
      `SANDBOX_SUPERVISOR_TOKEN=${supervisor}`,
      "SANDBOX_PROVIDER=docker",
      "QUIBT_WEB_BIND_HOST=127.0.0.1",
      "DATABASE_URL=postgres://quibt:quibt@postgres:5432/quibt",
      "WEB_ORIGIN=http://127.0.0.1:5173",
      "BETTER_AUTH_URL=http://127.0.0.1:5173",
      "API_URL=http://127.0.0.1:3100",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  return { path: target, created: true };
}

export async function detectDocker(
  run: (command: string, args: string[]) => Promise<{ code: number; stdout: string }> = runCommand,
): Promise<{ ok: boolean; message: string }> {
  try {
    const result = await run("docker", ["info"]);
    if (result.code === 0) return { ok: true, message: "Docker está no ar." };
    return {
      ok: false,
      message: "Docker respondeu com erro. Abra o Docker Desktop e tente de novo.",
    };
  } catch {
    return { ok: false, message: "Docker não encontrado. Instale o Docker Desktop." };
  }
}

export async function probeUrl(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export function sourceComposeArgs(composeFile: string, envFile: string): string[] {
  return ["compose", "-f", composeFile, "--env-file", envFile, "up", "-d", "--build"];
}

/** @deprecated Use sourceComposeArgs or composeInvocation from @quibt/installer */
export function composeArgs(composeFile: string, envFile: string): string[] {
  return sourceComposeArgs(composeFile, envFile);
}

export function readEnvHint(envFile: string): string {
  if (!existsSync(envFile)) return "";
  return readFileSync(envFile, "utf8").split("\n")[0] ?? "";
}

function runCommand(command: string, args: string[]) {
  return new Promise<{ code: number; stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk as Buffer));
    child.stderr.on("data", (chunk) => chunks.push(chunk as Buffer));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout: Buffer.concat(chunks).toString("utf8").slice(-4000) });
    });
  });
}
