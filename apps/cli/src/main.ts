#!/usr/bin/env node
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canRevealPairingSecrets,
  createClock,
  createProcessRunner,
  defaultCheckPort,
  defaultDataDir,
  defaultPublicUrl,
  finalizePairingInstall,
  INSTALL_RELEASE,
  type InstallerEvent,
  PAIRING_OUTPUT_REFUSED_MESSAGE,
  probeQuibtServicePort,
  resolveComposeFile,
  runDoctor,
  runInstall,
  runPair,
  runStatus,
  runUninstall,
  runUpdate,
  type SensitivePairingOutput,
  type UninstallEvent,
} from "@quibt/installer";

export type CliCommand =
  | "install"
  | "status"
  | "doctor"
  | "pair"
  | "update"
  | "uninstall"
  | "version"
  | "help";

export interface ParsedCli {
  command: CliCommand;
  nonInteractive: boolean;
  showSensitive: boolean;
  keepData: boolean;
  keepImages: boolean;
  /** `install --local`: nunca expor à internet, mesmo podendo. */
  local: boolean;
}

const VALID_COMMANDS = ["install", "status", "doctor", "pair", "update", "uninstall"] as const;

export class CliUsageError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = "CliUsageError";
    this.exitCode = exitCode;
  }
}

export function parseCli(args: string[]): ParsedCli {
  if (args.length === 0) {
    throw new CliUsageError("missing command");
  }

  const [first, ...rest] = args;

  const none = {
    nonInteractive: false,
    showSensitive: false,
    keepData: false,
    keepImages: false,
    local: false,
  };
  if (first === "--version") {
    return { command: "version", ...none };
  }

  if (first === "--help") {
    return { command: "help", ...none };
  }

  if (!VALID_COMMANDS.includes(first as (typeof VALID_COMMANDS)[number])) {
    throw new CliUsageError(`unknown command: ${first}`);
  }

  let nonInteractive = false;
  let showSensitive = false;
  let keepData = false;
  let keepImages = false;
  let local = false;
  for (const arg of rest) {
    // Não expor nada, mesmo numa VPS com IP público e 80/443 livres.
    if (arg === "--local" && first === "install") {
      local = true;
      continue;
    }
    if (arg === "--non-interactive") {
      nonInteractive = true;
      continue;
    }
    if (arg === "--show-sensitive") {
      showSensitive = true;
      continue;
    }
    // Só o uninstall entende o que manter; nos outros comandos a opção é erro.
    if (arg === "--keep-data" && first === "uninstall") {
      keepData = true;
      continue;
    }
    if (arg === "--keep-images" && first === "uninstall") {
      keepImages = true;
      continue;
    }
    throw new CliUsageError(`unknown option: ${arg}`);
  }

  return {
    command: first as CliCommand,
    nonInteractive,
    showSensitive,
    keepData,
    keepImages,
    local,
  };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    // `import.meta.url` is empty when this module is bundled to CommonJS for
    // the standalone SEA binary (scripts/build-cli-binary.mjs); the SEA entry
    // wrapper calls `runCliAsync` directly, so this must fail closed to
    // "not the main module" instead of throwing.
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

function printHelp(): void {
  console.log(`Usage: quibtbot <command>

Commands:
  install   Install or resume an installation
  status    Show services, version, and URL
  doctor    Run diagnostics without changing data
  pair      Issue a new pairing QR/code
  update    Update images with backup and verification
  uninstall Remove the Quibt services, bot computers, images and data dir

Options:
  --help            Show this help
  --version         Show version
  --local           (install) Keep everything on 127.0.0.1 even on a public VPS
  --non-interactive Run install without prompts
  --show-sensitive  Print pairing token/code/deep-link/QR on non-TTY stdout
  --keep-data       (uninstall) Keep the data dir: database, bot homes, secrets
  --keep-images     (uninstall) Keep the Docker images for a faster reinstall
`);
}

function printEvent(event: InstallerEvent, log: typeof console.log): void {
  const prefix = `[${event.step}] ${event.status}:`;
  log(`${prefix} ${event.message}`);
  if (event.detail) {
    log(JSON.stringify(event.detail, null, 2));
  }
}

function printUninstallEvent(event: UninstallEvent, log: typeof console.log): void {
  log(`[${event.step}] ${event.status}: ${event.message}`);
}

function printPairing(pairing: SensitivePairingOutput, log: typeof console.log): void {
  log(`URL: ${pairing.url}`);
  log(`Code: ${pairing.code}`);
  log(`Token: ${pairing.token}`);
  log(`Expires: ${pairing.expiresAt}`);
  log(`Deep link: ${pairing.deepLink}`);
  log(pairing.qrSvg);
}

export interface RunCliDeps {
  dataDir?: string;
  publicUrl?: string;
  composeFile?: string;
  exePath?: string;
  run?: ReturnType<typeof createProcessRunner>;
  fetch?: typeof fetch;
  clock?: ReturnType<typeof createClock>;
  checkPort?: (port: number) => Promise<boolean>;
  probeEndpoint?: (port: number) => Promise<boolean>;
  isTty?: boolean;
  showSensitive?: boolean;
  log?: typeof console.log;
  error?: typeof console.error;
}

/**
 * O binário de release leva o manifesto do compose dentro de si (asset da SEA). Quando não
 * há um ao lado do executável — o caso de `curl … | quibtbot install` numa VPS —, ele sai
 * do binário para a pasta de dados, e é esse arquivo que o compose passa a ler.
 */
async function embeddedComposeManifest(): Promise<string | null> {
  try {
    const sea = (await import("node:sea")) as {
      isSea?: () => boolean;
      getAsset?: (key: string, encoding: string) => string;
    };
    if (!sea.isSea?.() || !sea.getAsset) return null;
    return sea.getAsset("docker-compose.desktop.yml", "utf8");
  } catch {
    return null;
  }
}

const PINNED_IMAGE_NAMES = ["quibt-stack", "quibt-supervisor", "quibt-computer"] as const;

/**
 * A CLI release must replace any Compose extracted by an older binary. Keeping the
 * previous file would also keep its mutable image tags, defeating the immutable
 * digests embedded in the new executable during the release workflow.
 */
export function persistEmbeddedComposeManifest(dataDir: string, embedded: string): string {
  for (const image of PINNED_IMAGE_NAMES) {
    const pinned = new RegExp(`ghcr\\.io/quibt/${image}@sha256:[0-9a-f]{64}`, "i");
    if (!pinned.test(embedded)) {
      throw new CliUsageError(`Embedded Compose is missing the pinned digest for ${image}.`, 1);
    }
  }
  if (
    embedded.includes("${QUIBT_STACK_VERSION") ||
    /ghcr\.io\/quibt\/quibt-(?:stack|supervisor|computer):/.test(embedded)
  ) {
    throw new CliUsageError("Embedded Compose contains a mutable Quibt image reference.", 1);
  }

  const target = path.join(dataDir, "compose", "docker-compose.desktop.yml");
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, embedded, { encoding: "utf8", mode: 0o644 });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return target;
}

async function resolveComposePath(
  exePath: string,
  dataDir: string,
  override?: string,
): Promise<string> {
  if (override) return override;
  const resolved = resolveComposeFile(exePath);
  if (resolved.ok) return resolved.path;
  const embedded = await embeddedComposeManifest();
  if (embedded) {
    return persistEmbeddedComposeManifest(dataDir, embedded);
  }
  throw new CliUsageError(resolved.message, 2);
}

function mayPrintPairing(deps: RunCliDeps, parsed: ParsedCli): boolean {
  return canRevealPairingSecrets({
    isTty: deps.isTty,
    showSensitive: deps.showSensitive ?? parsed.showSensitive,
  });
}

export async function runCliAsync(args: string[], deps: RunCliDeps = {}): Promise<number> {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;

  try {
    const parsed = parseCli(args);
    if (parsed.command === "help") {
      printHelp();
      return 0;
    }
    if (parsed.command === "version") {
      log(INSTALL_RELEASE);
      return 0;
    }

    const exePath = deps.exePath ?? process.argv[1] ?? fileURLToPath(import.meta.url);
    const dataDir = deps.dataDir ?? defaultDataDir();
    const publicUrl = deps.publicUrl ?? defaultPublicUrl();
    const composeFile = await resolveComposePath(exePath, dataDir, deps.composeFile);
    const run = deps.run ?? createProcessRunner();
    const fetchImpl = deps.fetch ?? fetch;
    const clock = deps.clock ?? createClock();
    const checkPort = deps.checkPort ?? defaultCheckPort;
    const probeEndpoint =
      deps.probeEndpoint ??
      ((port: number) =>
        probeQuibtServicePort(port, {
          fetch: fetchImpl,
          run,
          composeFile,
          dataDir,
        }));

    switch (parsed.command) {
      case "install": {
        const result = await runInstall({
          dataDir,
          publicUrl,
          composeFile,
          composeMode: "packaged",
          forceLocal: parsed.local,
          publicAccess: { fetch: fetchImpl },
          run,
          fetch: fetchImpl,
          clock,
          onEvent: (event) => printEvent(event, log),
        });
        if (result.claimedInstruction) {
          log(result.claimedInstruction);
        }
        if (result.pairing) {
          if (mayPrintPairing(deps, parsed)) {
            printPairing(result.pairing, log);
            await finalizePairingInstall(dataDir, clock);
          } else {
            error(PAIRING_OUTPUT_REFUSED_MESSAGE);
            return 1;
          }
        }
        if (!result.ok) {
          if (result.error) error(result.error);
          return result.exitCode ?? 1;
        }
        return 0;
      }
      case "status": {
        const status = await runStatus({
          dataDir,
          publicUrl,
          composeFile,
          run,
          fetch: fetchImpl,
        });
        log(
          JSON.stringify(
            {
              release: status.release,
              url: status.url,
              healthy: status.healthy,
              completed: status.state?.completed ?? [],
              services: status.services,
            },
            null,
            2,
          ),
        );
        return status.healthy ? 0 : 1;
      }
      case "doctor": {
        const report = await runDoctor({
          dataDir,
          publicUrl,
          composeFile,
          run,
          fetch: fetchImpl,
          checkPort,
          probeEndpoint,
        });
        log(JSON.stringify(report, null, 2));
        return report.ok ? 0 : 1;
      }
      case "pair": {
        const paired = await runPair({ dataDir, publicUrl, fetch: fetchImpl });
        if (!paired.ok) {
          error(paired.message);
          return 1;
        }
        if (!mayPrintPairing(deps, parsed)) {
          error(PAIRING_OUTPUT_REFUSED_MESSAGE);
          return 1;
        }
        printPairing(paired.pairing, log);
        return 0;
      }
      case "uninstall": {
        const removed = await runUninstall({
          dataDir,
          composeFile,
          run,
          keepData: parsed.keepData,
          keepImages: parsed.keepImages,
          onEvent: (event) => printUninstallEvent(event, log),
        });
        for (const item of removed.leftovers) log(`Ficou: ${item}`);
        if (!removed.ok) {
          if (removed.error) error(removed.error);
          return 1;
        }
        log("O Quibt saiu desta máquina. O Docker e este binário continuam; apague-os se quiser.");
        return 0;
      }
      case "update": {
        const updated = await runUpdate({
          dataDir,
          composeFile,
          run,
          fetch: fetchImpl,
          clock,
          onEvent: (event) => printEvent(event, log),
        });
        if (!updated.ok) {
          if (updated.error) error(updated.error);
          return 1;
        }
        log(
          JSON.stringify(
            {
              release: updated.release,
              previousRelease: updated.previousRelease,
              backupPath: updated.backupPath,
            },
            null,
            2,
          ),
        );
        return 0;
      }
    }
  } catch (err) {
    if (err instanceof CliUsageError) {
      error(err.message);
      return err.exitCode;
    }
    error(err instanceof Error ? err.message : "unexpected error");
    return 1;
  }

  return 0;
}

export function runCli(args: string[]): void {
  void runCliAsync(args).catch((error) => {
    console.error(error instanceof Error ? error.message : "unexpected error");
    process.exitCode = 1;
  });
}

if (isMainModule()) {
  runCli(process.argv.slice(2));
}
