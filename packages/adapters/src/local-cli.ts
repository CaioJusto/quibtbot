import { constants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const LOCAL_CLI_PROVIDER = "local-cli";
export const BUILTIN_LOCAL_CLI_IDS = ["claude", "codex", "grok"] as const;
export const EXTRA_ACP_CLI_ID = "acp";
export const EXTRA_ACP_CLI_ENV = "QUIBT_EXTRA_ACP_CLI";
export const LOCAL_CLI_IDS = [...BUILTIN_LOCAL_CLI_IDS, EXTRA_ACP_CLI_ID] as const;

export type BuiltinLocalCliId = (typeof BUILTIN_LOCAL_CLI_IDS)[number];
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
  acp: "CLI ACP",
};

const SHELL_METACHARACTERS = /[|&;<>()$`\\*?[\]{}!~#'"\s]/;

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
  /** Override for tests; product path reads QUIBT_EXTRA_ACP_CLI. */
  extraAcpCli?: string;
};

/**
 * Resolves the built-in CLI names plus at most one extra ACP binary. In addition to PATH,
 * desktop and package-manager installs commonly land in ~/.local/bin or /usr/local/bin.
 */
export async function detectLocalCliEngines(
  options: LocalCliDetectionOptions = {},
): Promise<LocalCliEngine[]> {
  const found = await Promise.all(
    LOCAL_CLI_IDS.map(async (id) => {
      try {
        const executable = await resolveLocalCli(id, options);
        if (!executable) return null;
        const label = id === EXTRA_ACP_CLI_ID ? path.basename(executable) : localCliLabel(id);
        return { id, label, path: executable };
      } catch {
        return null;
      }
    }),
  );
  return found.filter((entry): entry is LocalCliEngine => entry !== null);
}

export function parseExtraAcpCliPath(
  raw: string | undefined,
  options: { homeDir?: string } = {},
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) return null;
  if (SHELL_METACHARACTERS.test(trimmed)) return null;
  if (trimmed.includes("\0") || trimmed.includes("..")) return null;
  const homeDir = options.homeDir ?? os.homedir();
  const resolved = path.resolve(trimmed);
  const allowedRoots = [path.resolve(homeDir, ".local", "bin"), path.resolve("/usr/local/bin")];
  const root = allowedRoots.find(
    (dir) => resolved === dir || resolved.startsWith(`${dir}${path.sep}`),
  );
  if (!root) return null;
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  if (path.basename(resolved) !== path.basename(trimmed)) return null;
  return resolved;
}

export async function resolveExtraAcpCli(
  options: LocalCliDetectionOptions = {},
): Promise<string | null> {
  try {
    const raw = options.extraAcpCli ?? (options.env ?? process.env)[EXTRA_ACP_CLI_ENV];
    const parsed = parseExtraAcpCliPath(raw, { homeDir: options.homeDir });
    if (!parsed) return null;
    const platform = options.platform ?? process.platform;
    await access(parsed, platform === "win32" ? constants.F_OK : constants.X_OK);
    return parsed;
  } catch {
    return null;
  }
}

export async function resolveLocalCli(
  id: string,
  options: LocalCliDetectionOptions = {},
): Promise<string | null> {
  if (!isLocalCliId(id)) return null;
  if (id === EXTRA_ACP_CLI_ID) return resolveExtraAcpCli(options);
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
    billing: `${engine.label} usa a sessão já conectada no host da API/worker e as ferramentas do computador do bot. Nenhuma chave é colada no Quibt.`,
    auth: "host-cli" as const,
    subscription: true,
  }));
}
