/**
 * Acesso remoto pelo Tailscale, no modelo que o gateway do OpenClaw usa: o produto
 * não instala nem faz login por você — isso continua sendo seu —, mas assim que o
 * `tailscale` existe e está logado, é o Quibt que sobe o `serve` e passa a entregar
 * um endereço https do tailnet no QR de "Conectar o celular".
 *
 * Por que isso importa: o endereço de LAN só vale dentro de casa e troca sozinho
 * quando o computador muda de rede, o que deixa o QR velho sem avisar. O nome do
 * tailnet é fixo e vale de qualquer lugar, inclusive no 4G do celular.
 */

export type TailscaleState =
  | { kind: "missing" }
  | { kind: "logged-out" }
  | { kind: "ready"; dnsName: string; ip: string | null };

export type RemoteAccess =
  | { kind: "off"; reason: "missing" | "logged-out" | "not-serving" }
  | { kind: "on"; url: string };

/** Saída de `tailscale status --json`, só os campos que interessam. */
type StatusJson = {
  BackendState?: string;
  Self?: { DNSName?: string; TailscaleIPs?: string[] };
};

export function parseTailscaleStatus(raw: string): TailscaleState {
  let parsed: StatusJson;
  try {
    parsed = JSON.parse(raw) as StatusJson;
  } catch {
    return { kind: "missing" };
  }
  // "NeedsLogin" e "Stopped" são o mesmo caso para quem usa: ainda não dá para servir.
  if (parsed.BackendState && parsed.BackendState !== "Running") return { kind: "logged-out" };
  const dnsName = (parsed.Self?.DNSName ?? "").replace(/\.$/, "");
  if (!dnsName) return { kind: "logged-out" };
  const ip = parsed.Self?.TailscaleIPs?.find((value) => value.includes(".")) ?? null;
  return { kind: "ready", dnsName, ip };
}

/**
 * A URL que o QR carrega. `tailscale serve` termina a conexão em TLS com um
 * certificado do próprio tailnet, então o endereço sai em https de verdade — sem
 * depender da exceção que o app abre para endereços de rede local.
 */
export function serveUrl(dnsName: string): string {
  return `https://${dnsName}`;
}

/** `tailscale serve status` responde vazio quando não há nada publicado. */
export function isServing(rawServeStatus: string, port: number): boolean {
  const text = rawServeStatus.trim();
  if (!text) return false;
  return text.includes(`127.0.0.1:${port}`) || text.includes(`localhost:${port}`);
}

export function serveArgs(port: number): string[] {
  return ["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`];
}

export function remoteAccessFrom(state: TailscaleState, serving: boolean): RemoteAccess {
  if (state.kind === "missing") return { kind: "off", reason: "missing" };
  if (state.kind === "logged-out") return { kind: "off", reason: "logged-out" };
  if (!serving) return { kind: "off", reason: "not-serving" };
  return { kind: "on", url: serveUrl(state.dnsName) };
}

/** Texto que a tela mostra; fala o que falta fazer, não o nome do erro. */
export function remoteAccessLabel(access: RemoteAccess): string {
  if (access.kind === "on") return "O celular alcança este computador de qualquer rede.";
  if (access.reason === "missing") {
    return "Instale o Tailscale neste computador para usar o celular fora de casa.";
  }
  if (access.reason === "logged-out") {
    return "Abra o Tailscale e entre na sua conta para liberar o acesso de fora de casa.";
  }
  return "Pronto para ligar: o celular passa a alcançar este computador de qualquer rede.";
}

// --- Execução real ------------------------------------------------------------
// A lógica acima é pura de propósito: o que fala com o binário mora aqui embaixo,
// numa casca fina, para os testes cobrirem as decisões sem depender do Tailscale
// estar instalado na máquina que roda a suíte.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Caminhos onde o CLI aparece: Homebrew (arm e intel) e o app da App Store. */
const CLI_CANDIDATES = [
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "tailscale",
];

async function cli(args: string[]): Promise<string | null> {
  for (const bin of CLI_CANDIDATES) {
    try {
      const { stdout } = await run(bin, args, { timeout: 8_000 });
      return stdout;
    } catch (error) {
      // Binário ausente: tenta o próximo caminho. Qualquer outra falha é do comando
      // em si (não logado, por exemplo) e quem decide o que fazer é o chamador.
      const code = (error as { code?: string }).code;
      if (code === "ENOENT") continue;
      return null;
    }
  }
  return null;
}

export async function readTailscaleState(): Promise<TailscaleState> {
  const raw = await cli(["status", "--json"]);
  if (raw === null) return { kind: "missing" };
  return parseTailscaleStatus(raw);
}

export async function readRemoteAccess(port = 3100): Promise<RemoteAccess> {
  const state = await readTailscaleState();
  if (state.kind !== "ready") return remoteAccessFrom(state, false);
  const status = await cli(["serve", "status"]);
  return remoteAccessFrom(state, isServing(status ?? "", port));
}

/** Liga o acesso remoto. Devolve o estado final, já relido do próprio Tailscale. */
export async function enableRemoteAccess(port = 3100): Promise<RemoteAccess> {
  const state = await readTailscaleState();
  if (state.kind !== "ready") return remoteAccessFrom(state, false);
  await cli(serveArgs(port));
  return readRemoteAccess(port);
}

export async function disableRemoteAccess(port = 3100): Promise<RemoteAccess> {
  await cli(["serve", "--https=443", "off"]);
  return readRemoteAccess(port);
}
