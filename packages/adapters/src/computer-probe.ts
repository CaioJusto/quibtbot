import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isAllowedSandboxEndpoint } from "@quibt/contracts";
import { bootableKind } from "@quibt/core";
import { isPrivateMcpAddress, type ResolveHost } from "./mcp-http.js";
import {
  BlockedAddressError,
  createGuardedFetch,
  type ProbeNetworkPolicy,
} from "./pinned-fetch.js";

export interface ComputerProbeInput {
  kind: string;
  endpoint?: string;
  apiKey?: string;
  supervisorUrl?: string;
  supervisorToken?: string;
}

export interface ComputerProbeResult {
  ok: boolean;
  message: string;
}

export interface ComputerProbeOptions {
  /** Os testes trocam o DNS; em produção é o `lookup` do Node. */
  resolveHost?: ResolveHost;
}

/**
 * Rota do supervisor que a sonda usa. Fica debaixo de `/computers/*`, que exige o token:
 * `/health` responde sem credencial (é o healthcheck do compose), então "Testar máquina"
 * dizia "Supervisor ok" com o token errado e todo boot falhava 401 depois.
 *
 * Um supervisor mais antigo não conhece esta rota e responde 404 — mas só depois do mesmo
 * guarda de token, então 404 continua provando que a credencial vale.
 */
export const SUPERVISOR_PROBE_PATH = "/computers/_probe";

export const COMPUTER_PROBE_TIMEOUT_MS = 4_000;

const resolveHostDefault: ResolveHost = async (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

const INSECURE_ENDPOINT_MESSAGE =
  "Use o endereço https do supervisor (ex. https://sua-vps.exemplo). Endereço de rede interna não é aceito, e http só vale em 127.0.0.1.";

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" || host === "host.docker.internal" || host === "::1" || /^127\./.test(host)
  );
}

/**
 * A mesma regra do preflight, na forma que o socket entende: o loopback documentado vale
 * pelo nome, e todo o resto vale pelo IP.
 */
const SUPERVISOR_PROBE_POLICY: ProbeNetworkPolicy = {
  isTrustedHost: isLoopbackHost,
  isAllowedLiteral: (address) => isLoopbackHost(address) || !isPrivateMcpAddress(address),
};

/**
 * Um nome vale pelo IP que ele entrega, não pelo texto: sem isto, `interno.exemplo` que
 * resolve para 10.0.0.5 continuava sendo uma requisição autenticada para dentro da rede.
 *
 * Isto é o preflight — quem escreve a frase amigável sem abrir socket. A palavra final é
 * do socket de `pinned-fetch.ts`, que conecta no IP conferido: o `fetch` global resolvia o
 * nome outra vez na hora de conectar, e o token ia junto para onde o segundo lookup
 * mandasse.
 */
async function resolvesToPublicAddress(target: string, resolver: ResolveHost): Promise<boolean> {
  const hostname = new URL(target).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHost(hostname)) return true;
  if (isIP(hostname)) return !isPrivateMcpAddress(hostname);
  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolver(hostname);
  } catch {
    return false;
  }
  return addresses.length > 0 && addresses.every(({ address }) => !isPrivateMcpAddress(address));
}

export async function probeComputer(
  input: ComputerProbeInput,
  fetchImpl?: typeof fetch,
  options: ComputerProbeOptions = {},
): Promise<ComputerProbeResult> {
  const boot = bootableKind(input.kind);
  if (!boot) {
    return { ok: false, message: `Máquina desconhecida: ${input.kind}` };
  }
  if (boot === "e2b") {
    const key = input.apiKey?.trim();
    if (!key) return { ok: false, message: "Cole a E2B_API_KEY para testar." };
    return { ok: true, message: "Chave presente. O próximo computador sobe na E2B." };
  }
  if (boot === "box") {
    const key = input.apiKey?.trim();
    if (!key) return { ok: false, message: "Cole a BOX_API_KEY para testar." };
    return { ok: true, message: "Chave presente. O próximo computador sobe no Box." };
  }
  if (boot === "daytona") {
    const key = input.apiKey?.trim();
    if (!key) return { ok: false, message: "Cole a DAYTONA_API_KEY para testar." };
    return { ok: true, message: "Chave presente. O próximo computador sobe na Daytona." };
  }
  const url = (input.endpoint || input.supervisorUrl || "").trim().replace(/\/$/, "");
  if (boot === "remote-supervisor" && !url) {
    return { ok: false, message: "Cole a URL https do supervisor da sua VPS." };
  }
  const target = url || "http://127.0.0.1:7091";
  if (!isAllowedSandboxEndpoint(target)) {
    return { ok: false, message: INSECURE_ENDPOINT_MESSAGE };
  }
  const token = input.apiKey?.trim() || input.supervisorToken?.trim();
  if (!token) {
    return {
      ok: false,
      message:
        "Cole o token do supervisor: sem ele não dá para saber se a máquina aceita este deploy.",
    };
  }
  const resolveHost = options.resolveHost ?? resolveHostDefault;
  if (!(await resolvesToPublicAddress(target, resolveHost))) {
    return { ok: false, message: INSECURE_ENDPOINT_MESSAGE };
  }
  // O `fetchImpl` dos testes entra como transporte; sem ele, quem conecta é o socket preso
  // no IP que a política aprovou.
  const send = createGuardedFetch({
    policy: SUPERVISOR_PROBE_POLICY,
    resolveHost,
    transport: fetchImpl,
  });
  let res: Response;
  try {
    res = await send(`${target}${SUPERVISOR_PROBE_PATH}`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(COMPUTER_PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    // O guarda do socket recusou o IP (o nome virou rede interna entre conferir e
    // conectar, ou o redirect apontou para dentro): a frase é a do endereço inseguro.
    if (error instanceof BlockedAddressError) {
      return { ok: false, message: INSECURE_ENDPOINT_MESSAGE };
    }
    const detail = error instanceof Error ? error.message : "sem resposta";
    return { ok: false, message: `Não alcançou ${target}: ${detail}` };
  }
  if (res.status === 401) {
    return { ok: false, message: `O supervisor respondeu em ${target}, mas recusou o token.` };
  }
  if (res.status === 503) {
    return {
      ok: false,
      message: `O supervisor respondeu em ${target}, mas o Docker dele está fora.`,
    };
  }
  // 404: supervisor antigo, sem a rota de sonda — já passou pelo mesmo guarda de token.
  if (res.ok || res.status === 404) {
    return { ok: true, message: `Supervisor ok em ${target}, e o token foi aceito.` };
  }
  return { ok: false, message: `Supervisor respondeu ${res.status} em ${target}.` };
}
