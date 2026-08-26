import { readFileSync } from "node:fs";
import type { DockerInvocation } from "./docker-invocation.js";
import {
  dockerComposeCommandCandidates,
  resolveDockerInvocation,
  runDockerCommand,
} from "./docker-invocation.js";
import { installDockerDesktopOnMac } from "./macos-docker.js";
import type { Clock, ProcessRunner } from "./orchestrator.js";

export type { DockerInvocation } from "./docker-invocation.js";
export { dockerArgv, resolveDockerInvocation, runDockerCommand } from "./docker-invocation.js";

export interface LinuxOsInfo {
  id: string;
  idLike: string[];
}

const SUPPORTED_APT = new Set(["ubuntu", "debian"]);
const SUPPORTED_DNF = new Set(["fedora", "rhel", "centos", "rocky", "almalinux", "amzn"]);

export function readLinuxOsInfo(): LinuxOsInfo | null {
  try {
    const release = readFileSync("/etc/os-release", "utf8");
    const id = release.match(/^ID=(.+)$/m)?.[1]?.replace(/^"|"$/g, "") ?? "";
    const idLike =
      release
        .match(/^ID_LIKE=(.+)$/m)?.[1]
        ?.replace(/^"|"$/g, "")
        .split(/\s+/)
        .filter(Boolean) ?? [];
    if (!id) return null;
    return { id, idLike };
  } catch {
    return null;
  }
}

export function linuxDockerInstallPlan(
  os: LinuxOsInfo,
): { manager: "apt" | "dnf"; packages: string[] } | null {
  if (SUPPORTED_APT.has(os.id) || os.idLike.some((entry) => SUPPORTED_APT.has(entry))) {
    return { manager: "apt", packages: ["docker.io"] };
  }
  if (SUPPORTED_DNF.has(os.id) || os.idLike.some((entry) => SUPPORTED_DNF.has(entry))) {
    return { manager: "dnf", packages: ["docker-ce", "docker-ce-cli", "containerd.io"] };
  }
  return null;
}

// Estas frases vão direto para a tela de quem instala. Dizem o que fazer, em
// português; o motivo técnico fica nos detalhes.
export function dockerDesktopMessage(platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return "O Docker Desktop não está aberto. Abra o Docker Desktop (a baleia) e tente de novo. Se ele não estiver instalado, baixe em https://docs.docker.com/desktop/setup/install/mac-install/";
  }
  if (platform === "win32") {
    return "O Docker Desktop não está aberto. Abra o Docker Desktop (a baleia) e tente de novo. Se ele não estiver instalado, baixe em https://docs.docker.com/desktop/setup/install/windows-install/";
  }
  return "O Docker não está disponível neste computador.";
}

export function linuxManualDockerMessage(os: LinuxOsInfo | null): string {
  const distro = os?.id ?? "a sua distribuição";
  return `Instale o Docker Engine para ${distro} pelo gerenciador de pacotes, ative o serviço docker e confira que o seu usuário consegue rodar 'docker info'. A instalação automática não foi tentada.`;
}

export function dockerSudoOnlyMessage(): string {
  return "O Docker só responde com sudo nesta máquina, e o sudo sem senha não está configurado. Configure o sudo sem senha para o docker ou adicione o seu usuário ao grupo docker.";
}

export { dockerNonInteractiveMessage } from "./macos-docker.js";

async function hasPasswordlessSudo(run: ProcessRunner): Promise<boolean> {
  if (process.getuid?.() === 0) return true;
  const probe = await run.run("sudo", ["-n", "true"]);
  return probe.code === 0;
}

/**
 * Quanto o instalador pode fazer pelo Docker Desktop no Mac: instalar (o install
 * comum), só abrir um que já está lá ("start-only", usado ao religar um stack já
 * instalado: nunca baixa nada nem pede a senha) ou nada.
 */
export type DesktopInstallPolicy = boolean | "start-only";

/** Por que falhou, quando dá para saber: o app volta para o modo instalação. */
export type DockerFailureReason = "desktop-missing";

export type EnsureDockerResult =
  | { ok: true; invocation: DockerInvocation }
  | { ok: false; message: string; reason?: DockerFailureReason };

export function composeMissingMessage(platform: NodeJS.Platform): string {
  if (platform === "darwin" || platform === "win32") {
    return "O Docker está no ar, mas o 'docker compose' não está disponível. Atualize o Docker Desktop (o Compose vem junto) e tente de novo.";
  }
  return "O Docker está no ar, mas falta o plugin do Compose ('docker compose version' falhou). Instale (Ubuntu/Debian: apt-get install docker-compose-v2 ou docker-compose-plugin; Fedora/RHEL: dnf install docker-compose-plugin) e rode o instalador de novo.";
}

/**
 * Tudo que o instalador faz passa por `docker compose`. Um Docker sem o plugin (o
 * `docker.io` do Ubuntu vem sem ele) passava na checagem e quebrava só no passo dos
 * serviços, com um "unknown shorthand flag: 'f'" que não explica nada. Aqui a falta é
 * dita com nome — e, no Linux com sudo sem senha, resolvida na hora.
 */
async function ensureCompose(
  deps: { run: ProcessRunner; platform?: NodeJS.Platform },
  invocation: DockerInvocation,
): Promise<EnsureDockerResult> {
  const platform = deps.platform ?? process.platform;
  const probe = await runDockerCommand(deps.run, invocation, ["compose", "version"]);
  if (probe.code === 0) return { ok: true, invocation };

  for (const command of dockerComposeCommandCandidates({ platform })) {
    const standalone =
      invocation.command === "sudo"
        ? { command: "sudo", prefixArgs: ["-n", command] }
        : { command, prefixArgs: [] };
    const standaloneProbe = await deps.run.run(standalone.command, [
      ...standalone.prefixArgs,
      "version",
    ]);
    if (standaloneProbe.code === 0) {
      return { ok: true, invocation: { ...invocation, compose: standalone } };
    }
  }

  if (platform !== "linux") return { ok: false, message: composeMissingMessage(platform) };
  const os = readLinuxOsInfo();
  const plan = os ? linuxDockerInstallPlan(os) : null;
  if (!plan || !(await hasPasswordlessSudo(deps.run))) {
    return { ok: false, message: composeMissingMessage(platform) };
  }
  const install =
    plan.manager === "apt"
      ? await deps.run.run("sudo", [
          "-n",
          "sh",
          "-c",
          "apt-get update && (DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-v2 || DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-plugin)",
        ])
      : await deps.run.run("sudo", ["-n", "sh", "-c", "dnf install -y docker-compose-plugin"]);
  if (install.code !== 0) return { ok: false, message: composeMissingMessage(platform) };
  const again = await runDockerCommand(deps.run, invocation, ["compose", "version"]);
  if (again.code === 0) return { ok: true, invocation };
  return { ok: false, message: composeMissingMessage(platform) };
}

export interface EnsureDockerDeps {
  run: ProcessRunner;
  platform?: NodeJS.Platform;
  arch?: string;
  username?: string;
  clock?: Pick<Clock, "sleep">;
  onProgress?: (message: string) => void;
  allowDesktopInstall?: DesktopInstallPolicy;
  /**
   * Ninguém na frente da tela: abrir um Docker Desktop já instalado ainda vale, mas
   * baixar e instalar (que pede a senha do Mac num prompt) não.
   */
  nonInteractive?: boolean;
}

export async function ensureDocker(deps: EnsureDockerDeps): Promise<EnsureDockerResult> {
  const engine = await ensureDockerEngine(deps);
  if (!engine.ok) return engine;
  return ensureCompose(deps, engine.invocation);
}

async function ensureDockerEngine(deps: EnsureDockerDeps): Promise<EnsureDockerResult> {
  const platform = deps.platform ?? process.platform;
  const resolved = await resolveDockerInvocation(deps.run, { platform });
  if (resolved) return { ok: true, invocation: resolved };

  if (platform === "darwin") {
    if (!deps.allowDesktopInstall) return { ok: false, message: dockerDesktopMessage(platform) };
    const startOnly = deps.allowDesktopInstall === "start-only";
    return installDockerDesktopOnMac({
      run: deps.run,
      arch: deps.arch,
      username: deps.username,
      clock: deps.clock,
      onProgress: deps.onProgress,
      nonInteractive: deps.nonInteractive || startOnly,
    });
  }

  if (platform === "win32") {
    return { ok: false, message: dockerDesktopMessage(platform) };
  }

  if (platform !== "linux") {
    return { ok: false, message: dockerDesktopMessage(platform) };
  }

  const os = readLinuxOsInfo();
  const plan = os ? linuxDockerInstallPlan(os) : null;
  if (!plan) {
    return { ok: false, message: linuxManualDockerMessage(os) };
  }

  const root = await hasPasswordlessSudo(deps.run);
  if (!root) {
    const direct = await deps.run.run("docker", ["info"]);
    if (direct.code !== 0) {
      const sudoProbe = await deps.run.run("sudo", ["-n", "docker", "info"]);
      if (sudoProbe.code !== 0) {
        return { ok: false, message: dockerSudoOnlyMessage() };
      }
    }
    return { ok: false, message: linuxManualDockerMessage(os) };
  }

  const install =
    plan.manager === "apt"
      ? await deps.run.run("sudo", [
          "-n",
          "sh",
          "-c",
          "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io && (DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-v2 || DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-plugin || true) && systemctl enable --now docker",
        ])
      : await deps.run.run("sudo", [
          "-n",
          "sh",
          "-c",
          "dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin && systemctl enable --now docker",
        ]);

  if (install.code !== 0) {
    return { ok: false, message: linuxManualDockerMessage(os) };
  }

  const service = await deps.run.run("sudo", ["-n", "systemctl", "is-active", "docker"]);
  if (service.code !== 0) {
    return { ok: false, message: linuxManualDockerMessage(os) };
  }

  const afterInstall = await resolveDockerInvocation(deps.run, { platform });
  if (afterInstall) return { ok: true, invocation: afterInstall };
  return { ok: false, message: linuxManualDockerMessage(os) };
}
