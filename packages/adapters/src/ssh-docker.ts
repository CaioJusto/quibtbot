import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer, type AddressInfo } from "node:net";

/** Mensagens de Testar / túnel. Nunca incluem stderr do SSH (pode trazer IdentityFile). */
export function sshAliasMissingMessage(alias: string): string {
  return `Não achei o alias SSH «${alias}» no ~/.ssh/config (ou o SSH pediu senha). Crie o Host no config e use chave; não cole senha nem chave aqui.`;
}

export function sshDockerUnreachableMessage(alias: string): string {
  return `O Docker em ssh://${alias} não respondeu. Confira se o Host existe no ~/.ssh/config, se o Docker está rodando na VPS e se a chave entra sem senha.`;
}

export const SSH_PUBLISHED_WEB_PORTS_MESSAGE =
  "Este caminho SSH recusa portas 80 ou 443 publicadas no Docker da VPS. Tire o mapeamento público e deixe o supervisor só na rede interna; a tela chega por um túnel temporário até 127.0.0.1.";

export const SSH_PUBLISHED_SUPERVISOR_MESSAGE =
  "Este caminho SSH recusa a porta 7091 publicada na internet. Deixe o supervisor só na rede Docker da VPS; a API no notebook chega por túnel até 127.0.0.1.";

export const SSH_SUPERVISOR_MISSING_MESSAGE =
  "Não achei o container do supervisor na VPS. Suba o Compose lá (sem publicar 80/443) e tente de novo.";

export const SSH_TUNNEL_FAILED_MESSAGE =
  "O túnel SSH da tela não abriu em 127.0.0.1. Confira o alias no ~/.ssh/config e se a chave entra sem senha.";

export type ProcessResult = { status: number; stdout: string; stderr: string };

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options?: { timeoutMs?: number },
) => Promise<ProcessResult>;

export type SshLocalForward = {
  localPort: number;
  origin: string;
  close: () => Promise<void>;
};

export type SshAliasResolution = { ok: true } | { ok: false; message: string };

export type OpenSshForward = (input: {
  alias: string;
  remoteHost: string;
  remotePort: number;
}) => Promise<SshLocalForward>;

/**
 * Porta injetável: os testes fakesiam SSH/Docker sem VPS. Produção usa o CLI
 * (`ssh -G`, `docker -H ssh://<alias>`).
 */
export interface SshDockerPort {
  resolveAlias(alias: string): Promise<SshAliasResolution>;
  refusePublishedWebPorts(alias: string): Promise<void>;
  supervisorOrigin(alias: string): Promise<string>;
  openNovncTunnel(alias: string, remoteUrl: string): Promise<SshLocalForward>;
}

export interface SshDockerOptions {
  run?: ProcessRunner;
  openForward?: OpenSshForward;
}

const DEFAULT_RUN_TIMEOUT_MS = 12_000;

export function defaultProcessRunner(
  command: string,
  args: readonly string[],
  options?: { timeoutMs?: number },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        timeout: options?.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
        encoding: "utf8",
        // Sem shell: o alias vai como argumento, não como linha interpolada.
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const status =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code ?? 1)
            : error
              ? 1
              : 0;
        resolve({
          status,
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
        });
      },
    );
  });
}

/**
 * HostPort 80/443 em `docker ps` ou no JSON do inspect. Qualquer publicação dessas
 * portas neste caminho é recusada — a tela não sai por HTTP público.
 */
export function portsPublishPublicHttp(text: string): boolean {
  if (/"HostPort"\s*:\s*"(80|443)"/.test(text)) return true;
  if (/(?:0\.0\.0\.0|\[::\]|\*|::):(?:80|443)->/.test(text)) return true;
  if (/(?:^|[\s,])(?:80|443)->\d+\/(?:tcp|udp)/.test(text)) return true;
  if (/->\s*(?:0\.0\.0\.0:|\[::\]:|\*:)?(?:80|443)\b/.test(text)) return true;
  return false;
}

/** 7091 ligada em 0.0.0.0 / :: — o supervisor na internet pública. */
export function portsPublishPublicSupervisor(text: string): boolean {
  if (/"HostPort"\s*:\s*"7091"/.test(text) && /0\.0\.0\.0|::|"HostIp"\s*:\s*""/.test(text)) {
    return true;
  }
  return /(?:0\.0\.0\.0|\[::\]|\*|::):7091->/.test(text);
}

export function rewriteScreenUrlToLoopback(remoteUrl: string, origin: string): string {
  const remote = new URL(remoteUrl);
  const local = new URL(origin);
  local.pathname = remote.pathname;
  local.search = remote.search;
  local.hash = remote.hash;
  return local.toString();
}

export async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitUntilListening(port: number, timeoutMs = 8_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port }, () => {
        socket.end();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(SSH_TUNNEL_FAILED_MESSAGE);
}

/**
 * `ssh -N -L 127.0.0.1:local:remoteHost:remotePort alias`.
 * Não registra stdout/stderr: ControlPath, IdentityFile e o destino do túnel não vão ao log.
 */
export async function openSshLocalForward(input: {
  alias: string;
  remoteHost: string;
  remotePort: number;
  localPort?: number;
}): Promise<SshLocalForward> {
  const localPort = input.localPort ?? (await allocateLoopbackPort());
  const child: ChildProcess = spawn(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=30",
      "-N",
      "-L",
      `127.0.0.1:${localPort}:${input.remoteHost}:${input.remotePort}`,
      input.alias,
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (!child.killed) child.kill("SIGTERM");
  };
  const died = new Promise<never>((_, reject) => {
    child.once("exit", () => {
      if (!closed) reject(new Error(SSH_TUNNEL_FAILED_MESSAGE));
    });
    child.once("error", () => {
      if (!closed) reject(new Error(SSH_TUNNEL_FAILED_MESSAGE));
    });
  });
  try {
    await Promise.race([waitUntilListening(localPort), died]);
  } catch (error) {
    await close();
    throw error;
  }
  return {
    localPort,
    origin: `http://127.0.0.1:${localPort}`,
    close,
  };
}

function supervisorLine(line: string): boolean {
  return /supervisor/i.test(line);
}

export function createSshDockerPort(options: SshDockerOptions = {}): SshDockerPort {
  const run = options.run ?? defaultProcessRunner;
  const openForward = options.openForward ?? openSshLocalForward;
  let supervisor: SshLocalForward | undefined;

  async function docker(alias: string, args: readonly string[]): Promise<ProcessResult> {
    return run("docker", ["-H", `ssh://${alias}`, ...args], { timeoutMs: 20_000 });
  }

  return {
    async resolveAlias(alias) {
      const result = await run("ssh", ["-o", "BatchMode=yes", "-G", alias], { timeoutMs: 8_000 });
      if (result.status !== 0) {
        return { ok: false, message: sshAliasMissingMessage(alias) };
      }
      return { ok: true };
    },

    async refusePublishedWebPorts(alias) {
      const result = await docker(alias, ["ps", "--format", "{{.Ports}}"]);
      if (result.status !== 0) {
        throw new Error(sshDockerUnreachableMessage(alias));
      }
      if (portsPublishPublicHttp(result.stdout)) {
        throw new Error(SSH_PUBLISHED_WEB_PORTS_MESSAGE);
      }
      if (portsPublishPublicSupervisor(result.stdout)) {
        throw new Error(SSH_PUBLISHED_SUPERVISOR_MESSAGE);
      }
    },

    async supervisorOrigin(alias) {
      if (supervisor) return supervisor.origin;
      const resolved = await this.resolveAlias(alias);
      if (!resolved.ok) throw new Error(resolved.message);
      await this.refusePublishedWebPorts(alias);
      const listed = await docker(alias, ["ps", "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}"]);
      if (listed.status !== 0) {
        throw new Error(sshDockerUnreachableMessage(alias));
      }
      const match = listed.stdout.split("\n").map((line) => line.trim()).find(supervisorLine);
      if (!match) throw new Error(SSH_SUPERVISOR_MISSING_MESSAGE);
      const id = match.split("\t")[0]?.trim();
      if (!id) throw new Error(SSH_SUPERVISOR_MISSING_MESSAGE);
      const inspected = await docker(alias, [
        "inspect",
        "-f",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
        id,
      ]);
      const host = inspected.stdout.trim().split(/\s+/).find(Boolean);
      if (!host) throw new Error(SSH_SUPERVISOR_MISSING_MESSAGE);
      supervisor = await openForward({ alias, remoteHost: host, remotePort: 7091 });
      return supervisor.origin;
    },

    async openNovncTunnel(alias, remoteUrl) {
      const parsed = new URL(remoteUrl);
      const port = parsed.port
        ? Number(parsed.port)
        : parsed.protocol === "https:"
          ? 443
          : 80;
      if (!Number.isInteger(port) || port < 1) {
        throw new Error("O supervisor não devolveu um endereço seguro para a tela.");
      }
      return openForward({ alias, remoteHost: parsed.hostname, remotePort: port });
    },
  };
}

export async function probeSshDockerComputer(input: {
  alias: string;
  ssh?: SshDockerPort;
}): Promise<{ ok: boolean; message: string }> {
  const ssh = input.ssh ?? createSshDockerPort();
  const resolved = await ssh.resolveAlias(input.alias);
  if (!resolved.ok) return { ok: false, message: resolved.message };
  try {
    await ssh.refusePublishedWebPorts(input.alias);
  } catch (error) {
    const message = error instanceof Error ? error.message : sshDockerUnreachableMessage(input.alias);
    return { ok: false, message };
  }
  return {
    ok: true,
    message: `Docker ok em ssh://${input.alias}. A tela chega por túnel até 127.0.0.1.`,
  };
}
