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
 * - `ollama`: GET {url}/api/tags — a "chave" aqui é a URL do daemon.
 * - `openai-compatible`: GET {url}/models — LM Studio, vLLM e afins.
 *
 * Todo outro provedor por chave (anthropic, openai, google, groq, mistral, deepseek,
 * cerebras, e o que mais o catálogo do Pi trouxer) não é sondado: a chave é aceita e
 * guardada, e um erro só aparece na primeira mensagem. Sondar cada um exigiria um
 * endpoint e um vocabulário de erro por provedor; os quatro acima cobrem o caminho
 * público do produto (OpenRouter, SuperGrok, Ollama, LM Studio).
 */

export const MODEL_PROBE_TIMEOUT_MS = 8_000;

/** Provedores que o probe sabe consultar. Os demais são aceitos sem consulta. */
export const PROBED_PROVIDERS = ["openrouter", "xai", "ollama", "openai-compatible"] as const;

export interface ModelProbeInput {
  provider: string;
  /** A chave de API — ou, nos provedores locais, a URL base do servidor. */
  apiKey: string;
}

export type ModelProbeResult =
  | { ok: true; message: string; probed: boolean }
  | { ok: false; message: string };

export interface ModelProbeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
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
        base: secret,
        path: "/api/tags",
        name: "O Ollama",
        example: "http://127.0.0.1:11434",
        openIt: "Abra o Ollama e tente de novo.",
      });
    case "openai-compatible":
      return probeLocal({
        fetchImpl,
        timeoutMs,
        base: secret,
        path: "/models",
        name: "O servidor do modelo",
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
    return {
      ok: false,
      message: `Não consegui falar com a ${input.vendor} (${describeFailure(error)}). Verifique a internet e tente de novo.`,
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
  base: string;
  path: string;
  name: string;
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
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch {
    return { ok: false, message: `${input.name} não respondeu em ${base}. ${input.openIt}` };
  }
  if (!res.ok) {
    return {
      ok: false,
      message: `${input.name} respondeu ${res.status} em ${base}. Confira a URL e tente de novo.`,
    };
  }
  return { ok: true, probed: true, message: `Servidor confirmado em ${base}.` };
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

/** "TimeoutError" e "fetch failed: ECONNREFUSED" viram duas palavras que a pessoa entende. */
function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "demorou demais";
    const cause = (error as { cause?: { code?: unknown } }).cause;
    if (cause && typeof cause.code === "string") return cause.code;
    return error.message || "sem resposta";
  }
  return "sem resposta";
}
