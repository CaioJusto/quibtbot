import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateMcpAddress, type ResolveHost } from "./mcp-http.js";
import { createGuardedFetch, type ProbeNetworkPolicy } from "./pinned-fetch.js";

/**
 * Sondagem da credencial do modelo antes de gravar.
 *
 * `models.connect` só cifrava e guardava: uma chave colada errada passava pelo
 * onboarding e falhava na primeira mensagem, com "401 Unauthorized" cru. Aqui o
 * provedor é consultado na hora, com timeout curto, e a resposta vira uma frase em
 * português que diz o que fazer.
 *
 * Quem é sondado:
 * - `openrouter`: GET /api/v1/auth/key (401/403 chave recusada, 402 sem crédito).
 * - `xai`: GET /v1/models com a chave.
 * - `ollama`: GET {raiz}/api/tags — a "chave" aqui é a URL do daemon. A raiz é a forma
 *   canônica gravada (um `/v1` colado no fim é removido); o runtime anexa `/v1` na hora
 *   de falar com `chat/completions`, que o Ollama só serve ali.
 * - `openai-compatible`: GET {url}/models — LM Studio, vLLM e afins; a URL já vem com /v1.
 *
 * Todo outro provedor por chave (anthropic, openai, google, groq, mistral, deepseek,
 * cerebras, e o que mais o catálogo do Pi trouxer) não é sondado: a chave é aceita e
 * guardada, e um erro só aparece na primeira mensagem. Sondar cada um exigiria um
 * endpoint e um vocabulário de erro por provedor; os quatro acima cobrem o caminho
 * público do produto (OpenRouter, SuperGrok, Ollama, LM Studio).
 *
 * Qualquer membro do workspace chama `models.connect`, e a URL local é dele. Para a API
 * não virar um oráculo de portas internas: nada de seguir redirect, o status numérico
 * não volta para a tela, e uma porta fechada, um serviço estranho e um corpo sem cara de
 * modelo terminam todos na MESMA frase — o que responde não vaza pela mensagem.
 *
 * Onde a sonda pode bater ({@link isAllowedModelEndpoint}) é uma política própria, e não
 * o guarda público de `mcp-http.ts`: o Ollama e o LM Studio moram em HTTP local, e de
 * dentro de um container o caminho de volta é `host.docker.internal`. Então:
 * - passa o loopback literal (127.x, ::1), `localhost` e `host.docker.internal`;
 * - passa um endereço público (um vLLM no servidor do dono);
 * - não passa 169.254.169.254 (metadados da nuvem), link-local, 10/8, 172.16/12,
 *   192.168/16, CGNAT, multicast e o resto do reservado;
 * - um nome é julgado pelo IP que ele resolve, não pelo texto, e um nome que aponta para
 *   a rede interna (ou para o loopback, o truque do rebinding) é recusado.
 *
 * E a conferência não termina no preflight: quem abre o socket é o `fetch` de
 * `pinned-fetch.ts`, preso nos IPs aprovados e com o mesmo guarda em cada redirect. Antes
 * disso o `fetch` global resolvia o nome OUTRA VEZ na hora de conectar, e o mesmo nome
 * podia responder 169.254.169.254 no segundo lookup.
 */

export const MODEL_PROBE_TIMEOUT_MS = 8_000;

/** Provedores que o probe sabe consultar. Os demais são aceitos sem consulta. */
export const PROBED_PROVIDERS = ["openrouter", "xai", "ollama", "openai-compatible"] as const;

/** O host que, de dentro de um container Docker, chega ao computador da pessoa. */
export const DOCKER_HOST_GATEWAY = "host.docker.internal";

export interface ModelProbeInput {
  provider: string;
  /** A chave de API — ou, nos provedores locais, a URL base do servidor. */
  apiKey: string;
}

export type ModelProbeResult =
  | {
      ok: true;
      message: string;
      probed: boolean;
      /** Nos provedores locais, a URL base normalizada que a sonda usou: é ela que vai ao cofre. */
      base?: string;
    }
  | { ok: false; message: string };

export interface ModelProbeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * A API roda num container (app desktop, compose). Ali 127.0.0.1 é o próprio
   * container, e "Abra o Ollama" para quem já o abriu seria conselho errado.
   */
  insideContainer?: boolean;
  /** Os testes trocam o DNS; em produção é o `lookup` do Node. */
  resolveHost?: ResolveHost;
}

/** Os nomes locais que a documentação promete, e que valem sem consultar o DNS. */
export const LOCAL_MODEL_HOSTS = ["localhost", DOCKER_HOST_GATEWAY] as const;

const resolveHostDefault: ResolveHost = async (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

/** Loopback literal: o computador da pessoa quando a API roda fora de container. */
function isLoopbackAddress(address: string): boolean {
  const value = address
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/^::ffff:/, "");
  if (isIP(value) === 4) return value.startsWith("127.");
  return isIP(value) === 6 && value === "::1";
}

/**
 * Para onde `models.connect` pode mandar uma requisição. Só o loopback literal, os nomes
 * locais documentados e os endereços públicos passam; o resto da rede interna — incluindo
 * um nome que resolve para dentro dela — é recusado antes de qualquer socket.
 */
export async function isAllowedModelEndpoint(
  base: string,
  resolver: ResolveHost = resolveHostDefault,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if ((LOCAL_MODEL_HOSTS as readonly string[]).includes(hostname)) return true;
  if (isIP(hostname)) return isLoopbackAddress(hostname) || !isPrivateMcpAddress(hostname);
  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolver(hostname);
  } catch {
    return false;
  }
  // Um nome vale pelo IP que ele entrega, e um só endereço interno derruba a lista
  // inteira: é assim que o rebinding deixa de valer a pena.
  return addresses.length > 0 && addresses.every(({ address }) => !isPrivateMcpAddress(address));
}

/**
 * A mesma política de {@link isAllowedModelEndpoint}, na forma que o socket entende: o
 * preflight e a conexão não podem divergir, então os dois leem daqui.
 */
const MODEL_PROBE_POLICY: ProbeNetworkPolicy = {
  isTrustedHost: (hostname) => (LOCAL_MODEL_HOSTS as readonly string[]).includes(hostname),
  isAllowedLiteral: (address) => isLoopbackAddress(address) || !isPrivateMcpAddress(address),
};

export function isProbedProvider(provider: string): boolean {
  return (PROBED_PROVIDERS as readonly string[]).includes(provider);
}

export async function probeModelCredential(
  input: ModelProbeInput,
  options: ModelProbeOptions = {},
): Promise<ModelProbeResult> {
  const resolveHost = options.resolveHost ?? resolveHostDefault;
  // O `fetchImpl` dos testes entra como transporte; sem ele, quem conecta é o socket
  // preso no IP que a política aprovou.
  const fetchImpl = createGuardedFetch({
    policy: MODEL_PROBE_POLICY,
    resolveHost,
    transport: options.fetchImpl,
  });
  const timeoutMs = options.timeoutMs ?? MODEL_PROBE_TIMEOUT_MS;
  const insideContainer = options.insideContainer ?? false;
  const secret = input.apiKey.trim();

  switch (input.provider) {
    case "openrouter":
      return probeKey({
        fetchImpl,
        timeoutMs,
        url: "https://openrouter.ai/api/v1/auth/key",
        apiKey: secret,
        vendor: "OpenRouter",
        refused:
          "Chave recusada pelo OpenRouter. Confira se copiou a chave inteira em openrouter.ai/keys.",
        unpaid:
          "Sem crédito na OpenRouter. Adicione crédito em openrouter.ai/credits e tente de novo.",
      });
    case "xai":
      return probeKey({
        fetchImpl,
        timeoutMs,
        url: "https://api.x.ai/v1/models",
        apiKey: secret,
        vendor: "xAI",
        refused:
          "Chave recusada pela xAI. Confira a chave em console.x.ai, ou entre com a assinatura SuperGrok.",
        unpaid: "Sem crédito na xAI. Adicione crédito em console.x.ai e tente de novo.",
      });
    case "ollama":
      return probeLocal({
        fetchImpl,
        timeoutMs,
        insideContainer,
        resolveHost,
        base: ollamaRoot(secret),
        path: "/api/tags",
        looksRight: (body) => Array.isArray((body as { models?: unknown })?.models),
        name: "O Ollama",
        looksLike: "o Ollama",
        example: "http://127.0.0.1:11434",
        openIt: "Abra o Ollama e tente de novo.",
      });
    case "openai-compatible":
      return probeLocal({
        fetchImpl,
        timeoutMs,
        insideContainer,
        resolveHost,
        base: secret,
        path: "/models",
        looksRight: (body) => Array.isArray((body as { data?: unknown })?.data),
        name: "O servidor do modelo",
        looksLike: "um servidor OpenAI-compatible",
        example: "http://127.0.0.1:1234/v1",
        openIt: "Abra o LM Studio (ou o servidor que você usa) e tente de novo.",
      });
    default:
      return {
        ok: true,
        probed: false,
        message: `Chave guardada. ${input.provider} só é conferido na primeira mensagem.`,
      };
  }
}

/** A raiz do daemon do Ollama: `http://host:11434/v1` e `http://host:11434` são a mesma coisa. */
function ollamaRoot(raw: string): string {
  return raw.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

async function probeKey(input: {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  url: string;
  apiKey: string;
  vendor: string;
  refused: string;
  unpaid: string;
}): Promise<ModelProbeResult> {
  if (!input.apiKey) return { ok: false, message: `Cole a chave da ${input.vendor}.` };
  let res: Response;
  try {
    res = await input.fetchImpl(input.url, {
      headers: { authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    const detail = describeFailure(error);
    return {
      ok: false,
      message: `Não consegui falar com a ${input.vendor}${detail ? ` (${detail})` : ""}. Verifique a internet e tente de novo.`,
    };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, message: input.refused };
  if (res.status === 402) return { ok: false, message: input.unpaid };
  if (!res.ok) {
    return {
      ok: false,
      message: `A ${input.vendor} respondeu ${res.status} ao conferir a chave. Tente de novo em instantes.`,
    };
  }
  return { ok: true, probed: true, message: `Chave confirmada pela ${input.vendor}.` };
}

async function probeLocal(input: {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  insideContainer: boolean;
  resolveHost: ResolveHost;
  base: string;
  path: string;
  looksRight: (body: unknown) => boolean;
  name: string;
  looksLike: string;
  example: string;
  openIt: string;
}): Promise<ModelProbeResult> {
  const base = normalizeBaseUrl(input.base);
  if (!base) {
    return { ok: false, message: `Cole a URL do servidor do modelo (ex. ${input.example}).` };
  }
  if (!(await isAllowedModelEndpoint(base, input.resolveHost))) {
    // Nenhum socket é aberto, e a frase é a mesma para o metadado da nuvem, para a
    // impressora do escritório e para o nome que aponta para dentro da rede.
    return {
      ok: false,
      message: `${input.name} precisa estar no seu computador ou num endereço público. Use ${input.example} (ou ${DOCKER_HOST_GATEWAY}, se o Quibt roda em Docker).`,
    };
  }
  // Porta fechada, servidor que demora, 3xx, 404 e corpo de outro serviço terminam nesta
  // frase única: a sonda não descreve o que mora em cada porta.
  const noAnswer: ModelProbeResult =
    input.insideContainer && isLoopback(base)
      ? {
          ok: false,
          message: `${input.name} não respondeu em ${base}. O Quibt roda em Docker e não alcança 127.0.0.1 do seu computador; use ${dockerHostUrl(base)}.`,
        }
      : { ok: false, message: `${input.name} não respondeu em ${base}. ${input.openIt}` };
  let res: Response;
  try {
    res = await input.fetchImpl(`${base}${input.path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch {
    return noAnswer;
  }
  if (!res.ok || !input.looksRight(await res.json().catch(() => null))) return noAnswer;
  return { ok: true, probed: true, base, message: `Servidor confirmado em ${base}.` };
}

function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    new URL(trimmed);
  } catch {
    return null;
  }
  return trimmed;
}

function isLoopback(base: string): boolean {
  try {
    const host = new URL(base).hostname;
    return (
      host === "localhost" ||
      host === "0.0.0.0" ||
      host === "[::1]" ||
      host === "::1" ||
      /^127\./.test(host)
    );
  } catch {
    return false;
  }
}

/** A mesma URL, com o host trocado pelo que sai do container: `http://host.docker.internal:11434`. */
function dockerHostUrl(base: string): string {
  const url = new URL(base);
  url.hostname = DOCKER_HOST_GATEWAY;
  return url.toString().replace(/\/$/, "");
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** O `code` do erro de rede do Node, que o undici guarda em `cause` (ou em `cause.errors`). */
function failureCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const cause = (error as { cause?: unknown }).cause ?? error;
  const direct = (cause as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const nested = (cause as { errors?: Array<{ code?: unknown }> }).errors?.[0]?.code;
  return typeof nested === "string" ? nested : undefined;
}

/**
 * "TimeoutError" e "fetch failed: ENOTFOUND" viram palavras que a pessoa entende; um
 * código que não está na lista é omitido, em vez de aparecer cru no meio da frase.
 */
function describeFailure(error: unknown): string | null {
  if (isTimeout(error)) return "demorou demais";
  switch (failureCode(error)) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "não achei o endereço";
    case "ECONNREFUSED":
      return "conexão recusada";
    case "ECONNRESET":
    case "ETIMEDOUT":
    case "EPIPE":
      return "a conexão caiu";
    default:
      return null;
  }
}
