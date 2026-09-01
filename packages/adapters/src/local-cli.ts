import { constants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const LOCAL_CLI_PROVIDER = "local-cli";
export const LOCAL_CLI_IDS = ["claude", "codex", "grok"] as const;

export type LocalCliId = (typeof LOCAL_CLI_IDS)[number];

export type LocalCliEngine = {
  id: LocalCliId;
  label: string;
  path: string;
};

const LABELS: Record<LocalCliId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
};

export function isLocalCliId(value: string): value is LocalCliId {
  return (LOCAL_CLI_IDS as readonly string[]).includes(value);
}

export function localCliLabel(id: LocalCliId): string {
  return LABELS[id];
}

export type LocalCliDetectionOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
};

/**
 * Resolves only the three supported executable names. In addition to PATH, desktop and
 * package-manager installs commonly land in ~/.local/bin or /usr/local/bin.
 */
export async function detectLocalCliEngines(
  options: LocalCliDetectionOptions = {},
): Promise<LocalCliEngine[]> {
  const found = await Promise.all(
    LOCAL_CLI_IDS.map(async (id) => {
      const executable = await resolveLocalCli(id, options);
      return executable ? { id, label: localCliLabel(id), path: executable } : null;
    }),
  );
  return found.filter((entry): entry is LocalCliEngine => entry !== null);
}

export async function resolveLocalCli(
  id: string,
  options: LocalCliDetectionOptions = {},
): Promise<string | null> {
  if (!isLocalCliId(id)) return null;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const dirs = new Set(
    (env.PATH ?? "")
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  dirs.add(path.join(homeDir, ".local", "bin"));
  dirs.add("/usr/local/bin");

  const extensions =
    platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((entry) => entry.toLowerCase())
      : [""];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.resolve(dir, `${id}${extension}`);
      try {
        await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        // Keep looking: PATH entries are expected to contain many unrelated directories.
      }
    }
  }
  return null;
}

export function localCliCatalog(engines: Iterable<LocalCliEngine>) {
  return [...engines].map((engine) => ({
    provider: LOCAL_CLI_PROVIDER,
    providerName: "CLI no host",
    id: engine.id,
    label: engine.label,
    billing: `${engine.label} usa a sessão já conectada no host da API/worker. Nenhuma chave é colada no Quibt.`,
    auth: "host-cli" as const,
    subscription: true,
  }));
}
