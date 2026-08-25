/**
 * Endereço público de uma instalação numa VPS, sem domínio de ninguém.
 *
 * O celular recusa `http://` fora da rede local (e está certo: a sessão iria em texto
 * puro pela operadora), então uma VPS precisa de HTTPS de verdade. A saída de sempre é
 * "traga o seu domínio", e é aí que a maioria desiste. O truque que evita isso é o
 * `sslip.io`: um DNS público e gratuito em que `qualquer-coisa.203.0.113.9.sslip.io`
 * resolve para `203.0.113.9`. Como isso é um *nome*, o Let's Encrypt emite certificado
 * para ele pela validação normal na porta 80. Resultado: cadeado de verdade no celular,
 * sem domínio de quem instala e sem domínio da Quibt no meio.
 *
 * O rótulo por instalação (`quibt-a1b2c3d4`) existe pelo mesmo motivo que no OpenClaw:
 * o Let's Encrypt limita emissões por nome exato, e provedores reciclam IPs. Um nome
 * novo por instalação nunca esbarra no limite de quem teve aquele IP antes.
 *
 * Tudo aqui é decidido ANTES de escrever o env: a instalação só fica pública quando
 * as três coisas são verdade — o host tem IP público, as portas 80 e 443 estão livres,
 * e o dono não pediu para ficar local. Qualquer dúvida cai para o modo local de hoje.
 */
import { randomBytes } from "node:crypto";
import net from "node:net";

export const SSLIP_SUFFIX = "sslip.io";
export const PUBLIC_HOST_ENV = "QUIBT_PUBLIC_HOST";
export const PUBLIC_PROFILE = "public";

/** Serviços que respondem o IPv4 público de quem pergunta, em texto puro. */
export const PUBLIC_IP_PROBES = [
  "https://api.ipify.org",
  "https://ipv4.icanhazip.com",
  "https://checkip.amazonaws.com",
] as const;

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isPublicIpv4(value: string): boolean {
  if (!IPV4.test(value)) return false;
  const [a, b] = value.split(".").map(Number) as [number, number];
  if (a === 10) return false;
  if (a === 127) return false;
  if (a === 0) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT / Tailscale
  if (a >= 224) return false; // multicast e reservado
  return true;
}

/** Rótulo curto, só letras e números, estável enquanto o env existir. */
export function instanceLabel(random: () => Buffer = () => randomBytes(4)): string {
  return `quibt-${random().toString("hex").slice(0, 8)}`;
}

export function sslipHost(label: string, ip: string): string {
  return `${label}.${ip}.${SSLIP_SUFFIX}`;
}

/** O IPv4 público deste host, ou `null` quando nenhum serviço responde com um. */
export async function discoverPublicIpv4(
  fetchImpl: typeof fetch = fetch,
  probes: readonly string[] = PUBLIC_IP_PROBES,
  timeoutMs = 4_000,
): Promise<string | null> {
  for (const url of probes) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      const text = (await res.text()).trim();
      if (isPublicIpv4(text)) return text;
    } catch {
      // Próximo serviço. Um fora do ar não pode decidir a instalação inteira.
    }
  }
  return null;
}

export type PortCheck = (port: number) => Promise<boolean>;

/** `true` quando dá para escutar na porta em todas as interfaces — ou seja, ela está livre. */
export function portIsFree(port: number, host = "0.0.0.0"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

export type PublicAccessDecision =
  | { mode: "public"; host: string; url: string; ip: string }
  | { mode: "local"; reason: string };

export interface PublicAccessInput {
  /** `--local` no CLI: o dono não quer expor nada, aconteça o que acontecer. */
  forceLocal?: boolean;
  /** Um host já gravado no env de uma instalação anterior vence a descoberta. */
  existingHost?: string;
  fetch?: typeof fetch;
  checkPort?: PortCheck;
  random?: () => Buffer;
}

/**
 * Decide se esta instalação vai ficar pública em `https://quibt-xxxx.<ip>.sslip.io`.
 * Nunca lança: a resposta "local" traz o motivo, que o instalador imprime — quem lê
 * sabe por que o celular só vai conectar pela rede de casa, e o que faria mudar isso.
 */
export async function decidePublicAccess(
  input: PublicAccessInput = {},
): Promise<PublicAccessDecision> {
  if (input.forceLocal) {
    return { mode: "local", reason: "Instalação local por escolha (--local)." };
  }
  if (input.existingHost) {
    const ip = input.existingHost.split(".").slice(-6, -2).join(".");
    return {
      mode: "public",
      host: input.existingHost,
      url: `https://${input.existingHost}`,
      ip,
    };
  }
  const ip = await discoverPublicIpv4(input.fetch ?? fetch);
  if (!ip) {
    return {
      mode: "local",
      reason:
        "Este computador não tem IP público, então o endereço fica na rede local. Numa VPS o HTTPS sai sozinho.",
    };
  }
  const checkPort = input.checkPort ?? ((port) => portIsFree(port));
  for (const port of [80, 443]) {
    if (!(await checkPort(port))) {
      return {
        mode: "local",
        reason: `A porta ${port} já está em uso neste servidor (outro site ou proxy). O Quibt fica em 127.0.0.1; ponha-o atrás do seu proxy com HTTPS para acessar de fora.`,
      };
    }
  }
  const host = sslipHost(instanceLabel(input.random), ip);
  return { mode: "public", host, url: `https://${host}`, ip };
}
