import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DockerInvocation } from "./docker-invocation.js";
import type { Clock, ProcessRunner } from "./orchestrator.js";

const DOCKER_TEAM_ID = "9BNSXJN65R";
const DOCKER_BUNDLE_ID = "com.docker.docker";
const DOCKER_APP = "/Applications/Docker.app";
const DOCKER_CLI = `${DOCKER_APP}/Contents/Resources/bin/docker`;
const DOCKER_INSTALLER = "Docker.app/Contents/MacOS/install";
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const DOCKER_START_ATTEMPTS = 240;
const DOCKER_START_INTERVAL_MS = 1_000;

export interface MacDockerInstallDeps {
  run: ProcessRunner;
  arch?: string;
  username?: string;
  clock?: Pick<Clock, "sleep">;
  onProgress?: (message: string) => void;
  /** Sem ninguém para digitar a senha: abrir um Docker instalado sim, instalar não. */
  nonInteractive?: boolean;
}

export type MacDockerInstallResult =
  | { ok: true; invocation: DockerInvocation }
  | { ok: false; message: string; reason?: "desktop-missing" };

export function dockerNonInteractiveMessage(): string {
  return "O Docker Desktop não está instalado e este modo (--non-interactive) não pode pedir a senha do Mac. Instale o Docker Desktop (https://docs.docker.com/desktop/setup/install/mac-install/) ou rode 'quibtbot install' num terminal para o Quibt instalar sozinho.";
}

export function dockerDesktopMacDownloadUrl(arch: string = process.arch): string | null {
  if (arch === "arm64") return "https://desktop.docker.com/mac/main/arm64/Docker.dmg";
  if (arch === "x64") return "https://desktop.docker.com/mac/main/amd64/Docker.dmg";
  return null;
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function privilegedDockerInstallAppleScript(
  installerPath: string,
  username: string,
): string {
  const command = `${shellQuote(installerPath)} --accept-license --user=${shellQuote(username)}`;
  return `do shell script ${appleScriptString(command)} with administrator privileges`;
}

async function waitForDocker(deps: MacDockerInstallDeps): Promise<DockerInvocation | null> {
  const sleep =
    deps.clock?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < DOCKER_START_ATTEMPTS; attempt += 1) {
    const probe = await deps.run.run(DOCKER_CLI, ["info"], { timeoutMs: 2_000 });
    if (probe.code === 0) return { command: DOCKER_CLI, prefixArgs: [] };
    await sleep(DOCKER_START_INTERVAL_MS);
  }
  return null;
}

async function startInstalledDocker(deps: MacDockerInstallDeps): Promise<MacDockerInstallResult> {
  deps.onProgress?.("Abrindo o Docker Desktop…");
  const opened = await deps.run.run("/usr/bin/open", ["-g", DOCKER_APP], {
    timeoutMs: 30_000,
  });
  if (opened.code !== 0) {
    return {
      ok: false,
      message: "O Docker Desktop foi instalado, mas o macOS não conseguiu abri-lo.",
    };
  }

  deps.onProgress?.("Aguardando o Docker ficar pronto…");
  const invocation = await waitForDocker(deps);
  if (invocation) return { ok: true, invocation };
  return {
    ok: false,
    message:
      "O Docker Desktop abriu, mas não ficou pronto em 4 minutos. Confira se o macOS mostrou algum pedido de permissão e tente novamente.",
  };
}

function dockerIdentityIsTrusted(details: string): boolean {
  return (
    details.includes(`Identifier=${DOCKER_BUNDLE_ID}`) &&
    details.includes(`TeamIdentifier=${DOCKER_TEAM_ID}`)
  );
}

/**
 * Installs Docker Desktop using Docker's documented command-line flow. The
 * download is elevated only after macOS validates the app signature and the
 * expected Docker Team ID. macOS owns the single administrator-password prompt.
 */
export async function installDockerDesktopOnMac(
  deps: MacDockerInstallDeps,
): Promise<MacDockerInstallResult> {
  const installed = await deps.run.run("/usr/bin/test", ["-x", DOCKER_CLI]);
  if (installed.code === 0) return startInstalledDocker(deps);

  // Daqui em diante há um prompt de senha do macOS no caminho. Sem ninguém na frente
  // da tela ele ficaria pendurado para sempre; melhor falar o que falta e sair.
  if (deps.nonInteractive) {
    return { ok: false, message: dockerNonInteractiveMessage(), reason: "desktop-missing" };
  }

  const url = dockerDesktopMacDownloadUrl(deps.arch);
  if (!url) {
    return {
      ok: false,
      message: `O Docker Desktop não oferece instalador automático para esta arquitetura (${deps.arch ?? process.arch}).`,
    };
  }

  const username = deps.username ?? os.userInfo().username;
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
    return {
      ok: false,
      message: "O nome do usuário do macOS não é compatível com a instalação automática.",
    };
  }

  const workDir = mkdtempSync(path.join(os.tmpdir(), "quibt-docker-"));
  const dmgPath = path.join(workDir, "Docker.dmg");
  const mountPath = path.join(workDir, "mount");
  const mountedApp = path.join(mountPath, "Docker.app");
  let mounted = false;

  try {
    mkdirSync(mountPath, { mode: 0o700 });
    deps.onProgress?.("Baixando o Docker Desktop oficial…");
    const download = await deps.run.run(
      "/usr/bin/curl",
      ["--fail", "--location", "--silent", "--show-error", "--output", dmgPath, url],
      { timeoutMs: DOWNLOAD_TIMEOUT_MS },
    );
    if (download.code !== 0) {
      return {
        ok: false,
        message: `Não foi possível baixar o Docker Desktop: ${download.stderr.trim() || "falha de rede"}`,
      };
    }

    deps.onProgress?.("Verificando a assinatura do Docker Desktop…");
    const attached = await deps.run.run(
      "/usr/bin/hdiutil",
      ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPath, dmgPath],
      { timeoutMs: 120_000 },
    );
    if (attached.code !== 0) {
      return { ok: false, message: "O download do Docker Desktop não pôde ser aberto." };
    }
    mounted = true;

    const verified = await deps.run.run(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", "--verbose=2", mountedApp],
      { timeoutMs: 120_000 },
    );
    if (verified.code !== 0) {
      return { ok: false, message: "A assinatura do Docker Desktop baixado é inválida." };
    }

    const identity = await deps.run.run("/usr/bin/codesign", ["-dv", "--verbose=4", mountedApp], {
      timeoutMs: 30_000,
    });
    if (!dockerIdentityIsTrusted(`${identity.stdout}\n${identity.stderr}`)) {
      return { ok: false, message: "O instalador baixado não pertence à Docker Inc." };
    }

    const gatekeeper = await deps.run.run(
      "/usr/sbin/spctl",
      ["--assess", "--type", "execute", "--verbose=2", mountedApp],
      { timeoutMs: 120_000 },
    );
    if (gatekeeper.code !== 0) {
      return { ok: false, message: "O macOS recusou o instalador oficial do Docker Desktop." };
    }

    deps.onProgress?.("Confirme a senha do Mac para concluir o Docker…");
    const installerPath = path.join(mountPath, DOCKER_INSTALLER);
    const installedResult = await deps.run.run(
      "/usr/bin/osascript",
      ["-e", privilegedDockerInstallAppleScript(installerPath, username)],
      { timeoutMs: INSTALL_TIMEOUT_MS },
    );
    if (installedResult.code !== 0) {
      const cancelled = /User canceled|cancelou|-128/i.test(installedResult.stderr);
      return {
        ok: false,
        message: cancelled
          ? "A instalação do Docker foi cancelada na confirmação do macOS."
          : `O Docker Desktop não pôde ser instalado: ${installedResult.stderr.trim() || "falha do instalador"}`,
      };
    }
  } finally {
    if (mounted) {
      await deps.run.run("/usr/bin/hdiutil", ["detach", mountPath, "-force"], {
        timeoutMs: 120_000,
      });
    }
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // A failed detach must not hide the real installation result. macOS will
      // clean this private temporary directory on its normal maintenance cycle.
    }
  }

  return startInstalledDocker(deps);
}
