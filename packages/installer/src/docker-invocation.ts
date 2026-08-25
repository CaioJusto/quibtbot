import os from "node:os";
import path from "node:path";
import type { ProcessRunner } from "./orchestrator.js";

export interface DockerInvocation {
  command: string;
  prefixArgs: string[];
  compose?: {
    command: string;
    prefixArgs: string[];
  };
}

export interface DockerResolveOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
}

const DOCKER_PROBE_TIMEOUT_MS = 5_000;

/**
 * Apps opened from Finder do not inherit the user's interactive shell PATH.
 * Probe the locations used by Docker Desktop, Homebrew and Docker's per-user
 * CLI install before concluding that Docker is missing.
 */
export function dockerCommandCandidates(options: DockerResolveOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();

  if (platform === "darwin") {
    return [
      path.join(homeDir, ".docker", "bin", "docker"),
      "/Applications/Docker.app/Contents/Resources/bin/docker",
      "/opt/homebrew/bin/docker",
      "/usr/local/bin/docker",
    ];
  }

  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    return [
      ...(localAppData
        ? [path.join(localAppData, "Programs", "DockerDesktop", "resources", "bin", "docker.exe")]
        : []),
      "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
    ];
  }

  return [];
}

/**
 * Docker installed by Homebrew can expose Compose as a standalone CLI even
 * when `docker compose` cannot discover the plugin from a Finder-launched app's
 * reduced PATH. Keep those absolute locations explicit so local installation
 * remains automatic on Colima/Homebrew setups as well as Docker Desktop.
 */
export function dockerComposeCommandCandidates(options: DockerResolveOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();

  if (platform === "darwin") {
    return [
      path.join(homeDir, ".docker", "cli-plugins", "docker-compose"),
      "/Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose",
      "/opt/homebrew/bin/docker-compose",
      "/opt/homebrew/lib/docker/cli-plugins/docker-compose",
      "/usr/local/bin/docker-compose",
      "/usr/local/lib/docker/cli-plugins/docker-compose",
    ];
  }

  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    return [
      ...(localAppData
        ? [
            path.join(
              localAppData,
              "Programs",
              "DockerDesktop",
              "resources",
              "cli-plugins",
              "docker-compose.exe",
            ),
          ]
        : []),
      "C:\\Program Files\\Docker\\Docker\\resources\\cli-plugins\\docker-compose.exe",
    ];
  }

  return ["docker-compose", "/usr/local/bin/docker-compose", "/usr/bin/docker-compose"];
}

export function dockerArgv(inv: DockerInvocation, args: string[]): [string, string[]] {
  if (args[0] === "compose" && inv.compose) {
    return [inv.compose.command, [...inv.compose.prefixArgs, ...args.slice(1)]];
  }
  if (inv.prefixArgs.length === 0) {
    return [inv.command, args];
  }
  return [inv.command, [...inv.prefixArgs, ...args]];
}

async function attachComposeInvocation(
  run: ProcessRunner,
  invocation: DockerInvocation,
  options: DockerResolveOptions,
): Promise<DockerInvocation> {
  const plugin = await run.run(
    invocation.command,
    [...invocation.prefixArgs, "compose", "version"],
    { timeoutMs: DOCKER_PROBE_TIMEOUT_MS },
  );
  if (plugin.code === 0) return invocation;

  for (const command of dockerComposeCommandCandidates(options)) {
    const standalone =
      invocation.command === "sudo"
        ? { command: "sudo", prefixArgs: ["-n", command] }
        : { command, prefixArgs: [] };
    const probe = await run.run(standalone.command, [...standalone.prefixArgs, "version"], {
      timeoutMs: DOCKER_PROBE_TIMEOUT_MS,
    });
    if (probe.code === 0) return { ...invocation, compose: standalone };
  }

  return invocation;
}

export async function resolveDockerInvocation(
  run: ProcessRunner,
  options: DockerResolveOptions = {},
): Promise<DockerInvocation | null> {
  const platform = options.platform ?? process.platform;
  const direct = await run.run("docker", ["info"], { timeoutMs: DOCKER_PROBE_TIMEOUT_MS });
  if (direct.code === 0) {
    return attachComposeInvocation(run, { command: "docker", prefixArgs: [] }, options);
  }

  for (const command of dockerCommandCandidates(options)) {
    const probe = await run.run(command, ["info"], { timeoutMs: DOCKER_PROBE_TIMEOUT_MS });
    if (probe.code === 0) {
      return attachComposeInvocation(run, { command, prefixArgs: [] }, options);
    }
  }

  if (platform !== "win32" && process.getuid?.() !== 0) {
    const sudo = await run.run("sudo", ["-n", "docker", "info"], {
      timeoutMs: DOCKER_PROBE_TIMEOUT_MS,
    });
    if (sudo.code === 0) {
      return attachComposeInvocation(
        run,
        { command: "sudo", prefixArgs: ["-n", "docker"] },
        options,
      );
    }
  }

  return null;
}

export async function runDockerCommand(
  run: ProcessRunner,
  inv: DockerInvocation,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
) {
  const [command, argv] = dockerArgv(inv, args);
  return run.run(command, argv, options);
}
