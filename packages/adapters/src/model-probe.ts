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
 * não volta para a tela, e só um corpo com a cara do Ollama / de um servidor
 * OpenAI-compatible conta como "confirmado".
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
}

export function isProbedProvider(provider: string): boolean {
  return (PROBED_PROVIDERS as readonly string[]).includes(provider);
}

export async function probeModelCredential(
  input: ModelProbeInput,
  options: ModelProbeOptions = {},
): Promise<ModelProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
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
  let res: Response;
  try {
    res = await input.fetchImpl(`${base}${input.path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    if (input.insideContainer && isLoopback(base) && !isTimeout(error)) {
      return {
        ok: false,
        message: `${input.name} não respondeu em ${base}. O Quibt roda em Docker e não alcança 127.0.0.1 do seu computador; use ${dockerHostUrl(base)}.`,
      };
    }
    return { ok: false, message: `${input.name} não respondeu em ${base}. ${input.openIt}` };
  }
  // Um 3xx (redirect: manual), um 404 ou um corpo de outro serviço caem todos aqui; o
  // status não volta para a tela, para a sonda não descrever o que mora em cada porta.
  if (!res.ok || !input.looksRight(await res.json().catch(() => null))) {
    return {
      ok: false,
      message: `Algo respondeu em ${base}, mas não parece ${input.looksLike}. Confira a URL e tente de novo.`,
    };
  }
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
