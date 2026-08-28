#!/usr/bin/env node
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

/**
 * FERRAMENTA DE DESENVOLVIMENTO. Não é produto, não é caminho de instalação e não
 * aparece em nenhuma tela: é um cliente de terminal para conversar com um bot enquanto
 * a pilha local (`pnpm dev`) está no ar.
 *
 * Ele só usa o que já existe:
 *   - `POST /api/local/session` para entrar sem senha — a MESMA porta do navegador local,
 *     com as MESMAS guardas do servidor (ver apps/api/src/app.ts). Este script não manda
 *     `x-forwarded-*`, não assina capacidade de desktop e não imita proxy nenhum. Se o
 *     servidor recusar, ele pede o token à pessoa em vez de dar a volta na guarda.
 *   - `POST /rpc/<proc>` com corpo `{"json": …}` e resposta `{"json": …}` — o mesmo fio
 *     que o app do celular usa (apps/mobile/lib/api.ts).
 */

export const DEFAULT_BASE = "http://127.0.0.1:3100";

export function helpText() {
  return `pnpm dev:chat — conversa com um bot pelo terminal (FERRAMENTA DE DEV)

Isto NÃO é o produto. É um cliente cru para desenvolvimento, contra a pilha local
que "pnpm dev" já sobe. Para usar o Quibt de verdade, abra http://127.0.0.1:5173.

Uso:
  pnpm dev:chat [bot] [opções]

Argumentos:
  bot               Nome ou id do bot. Sem isso, usa o primeiro da lista.

Opções:
  --help            Mostra esta ajuda
  --url <endereço>  API a usar (padrão: ${DEFAULT_BASE}, ou API_URL)

Ambiente:
  API_URL           Mesma coisa que --url
  QUIBT_TOKEN       Token de sessão já obtido. Necessário quando a API não é loopback,
                    ou quando ela recusa a entrada automática. Nunca é impresso.

Dentro da conversa:
  /parar            Interrompe o que o bot está fazendo
  /sair             Fecha (Ctrl+C também)
`;
}

export function parseArgs(argv, env = {}) {
  const parsed = { help: false, bot: null, base: env.API_URL ?? DEFAULT_BASE };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--url") {
      const value = argv[index + 1];
      if (!value) return { ...parsed, error: "--url precisa de um endereço." };
      parsed.base = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) return { ...parsed, error: `opção desconhecida: ${arg}` };
    if (parsed.bot) return { ...parsed, error: `argumento a mais: ${arg}` };
    parsed.bot = arg;
  }
  return parsed;
}

/** Tira a barra final para `${base}/rpc/...` nunca virar `//rpc/...`. */
export function normalizeBase(base) {
  return String(base).replace(/\/+$/, "");
}

/**
 * A entrada sem senha só existe no loopback, e é o SERVIDOR quem decide isso
 * (`deploymentAllowsLocalSession`). Aqui a checagem é repetida antes de tentar, para o
 * script nunca mandar um pedido de sessão para um endereço que não é esta máquina.
 */
export function isLoopbackBase(base) {
  try {
    const host = new URL(base).hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "::1") return true;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
    return host.startsWith("127.");
  } catch {
    return false;
  }
}

export function createRpc({ base, fetch: fetchImpl = fetch, token = "" }) {
  const root = normalizeBase(base);
  return async function rpc(proc, input = {}) {
    const res = await fetchImpl(`${root}/rpc/${proc}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ json: input }),
    });
    const parsed = await res.json().catch(() => ({}));
    const failure = parsed.error ?? (isRpcError(parsed.json) ? parsed.json : undefined);
    if (!res.ok || failure) {
      if (res.status === 401) {
        throw new Error("A sessão não vale (401). Rode de novo, ou passe QUIBT_TOKEN.");
      }
      throw new Error(failure?.message ?? `rpc ${proc} falhou (HTTP ${res.status}).`);
    }
    return parsed.json;
  };
}

function isRpcError(value) {
  return typeof value === "object" && value !== null && "message" in value;
}

/**
 * Entra como dono. Nunca contorna a guarda: sem loopback nem token, ele explica e para.
 */
export async function login({ base, fetch: fetchImpl = fetch, token = "" }) {
  if (token) return { token, name: "", source: "ambiente" };
  if (!isLoopbackBase(base)) {
    throw new Error(
      `${normalizeBase(base)} não é loopback: a entrada automática não existe aí, de propósito. ` +
        "Pegue um token de sessão desta instalação e rode com QUIBT_TOKEN=… pnpm dev:chat",
    );
  }
  const res = await fetchImpl(`${normalizeBase(base)}/api/local/session`, { method: "POST" });
  const body = await res.json().catch(() => ({}));
  if (res.status === 404) {
    throw new Error(
      "Esta instalação não abre sessão local (404). Ela só existe quando WEB_ORIGIN e " +
        "BETTER_AUTH_URL são loopback e o pedido chega pelo loopback. Use QUIBT_TOKEN=… em vez de forçar.",
    );
  }
  if (!res.ok) {
    throw new Error(body.message ?? `Não deu para entrar (HTTP ${res.status}).`);
  }
  if (!body.token) {
    throw new Error(
      "A API entrou por cookie e não devolveu token para o terminal. Passe QUIBT_TOKEN=…",
    );
  }
  return { token: body.token, name: body.name ?? "", source: "sessão local" };
}

export function pickBot(bots, wanted) {
  if (!Array.isArray(bots) || bots.length === 0) {
    throw new Error("Nenhum bot nesta instalação. Crie um em http://127.0.0.1:5173 e volte.");
  }
  if (!wanted) return bots[0];
  const found = bots.find((bot) => bot.id === wanted || bot.name === wanted);
  if (!found) {
    throw new Error(`Não achei o bot "${wanted}". Tem: ${bots.map((bot) => bot.name).join(", ")}`);
  }
  return found;
}

/** O discriminante do bloco é `kind` (packages/contracts/src/events.ts). */
export function renderBlock(block) {
  if (!block || typeof block !== "object") return "";
  switch (block.kind) {
    case "text":
    case "meta":
    case "progress":
    case "computer":
      return typeof block.text === "string" ? block.text : "";
    case "ask": {
      const actions = (block.actions ?? []).map((action) => action.label).join(" / ");
      return `[pergunta] ${block.text}${actions ? ` (${actions})` : ""}`;
    }
    case "choice": {
      const options = (block.options ?? [])
        .map((option) => `  ${option.letter}) ${option.label}`)
        .join("\n");
      return `[escolha] ${block.question}${options ? `\n${options}` : ""}`;
    }
    case "card":
      return (block.lines ?? []).map((line) => `  ${line.k}: ${line.v}`).join("\n");
    case "file":
      return `[arquivo] ${block.name} (${block.mimeType}, ${block.size} bytes)`;
    case "connect":
      return `[conexão] ${block.name}: ${block.status}`;
    case "subagent":
      return `[subagente] ${block.name}: ${block.status}`;
    case "child_bot":
      return `[bot filho] ${block.name}: ${block.status}`;
    default:
      return block.kind ? `[${block.kind}]` : "";
  }
}

export function renderMessage(message) {
  const who = message.role === "user" ? "você" : message.role === "system" ? "sistema" : "bot";
  const text = (message.blocks ?? [])
    .map(renderBlock)
    .filter((line) => line.length > 0)
    .join("\n");
  return `${who} › ${text || "(sem texto)"}`;
}

/** Enquanto o run está numa destas, o bot ainda está trabalhando (packages/contracts/src/ids.ts). */
const RUNNING_STATUSES = new Set(["queued", "leased", "running"]);

/** Um run que parou — inclusive parado esperando a pessoa — devolve o prompt. */
export function runIsOver(run) {
  if (!run) return true;
  return !RUNNING_STATUSES.has(run.status);
}

/**
 * Quando o bot está parado numa pergunta, o texto digitado é a RESPOSTA daquele run
 * (`threads/answer`), não um recado novo — mandar `threads/send` aí deixaria a pergunta
 * pendurada.
 */
export function commandFor(text, run, botId) {
  if (text === "/parar") return { proc: "threads/stop", input: { botId } };
  if (run?.status === "waiting_input" && run.id) {
    return { proc: "threads/answer", input: { botId, runId: run.id, answer: text } };
  }
  return { proc: "threads/send", input: { botId, text } };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2), process.env);
  if (parsed.error) {
    console.error(parsed.error);
    console.error(helpText());
    process.exit(2);
  }
  if (parsed.help) {
    console.log(helpText());
    return;
  }

  const base = normalizeBase(parsed.base);
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: token de sessão para ferramenta de dev
  const envToken = process.env.QUIBT_TOKEN ?? "";

  const health = await fetch(`${base}/health`)
    .then((res) => res.json())
    .catch(() => null);
  if (!health) {
    console.error(`Não achei a API em ${base}. A pilha local está no ar? (pnpm dev)`);
    process.exit(1);
  }
  if (!health.worker?.alive) {
    console.error("Aviso: nenhum worker vivo. O bot recebe o recado e não responde.");
  }

  const session = await login({ base, token: envToken });
  const rpc = createRpc({ base, token: session.token });
  const bots = await rpc("bots/list");
  const bot = pickBot(bots, parsed.bot);

  console.log(
    `Quibt dev chat — ${session.name || "dono"} → ${bot.name} (${bot.id}) via ${session.source}.`,
  );
  console.log("Comandos: /parar, /sair.");

  let snapshot = await rpc("threads/get", { botId: bot.id });
  for (const message of snapshot.messages.slice(-10)) console.log(renderMessage(message));
  let cursor = snapshot.cursor;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      let text;
      try {
        text = (await rl.question("> ")).trim();
      } catch {
        // A entrada acabou: Ctrl+D, ou um roteiro de teste vindo por pipe.
        break;
      }
      if (!text) continue;
      if (text === "/sair") break;
      const next = commandFor(text, snapshot.run, bot.id);
      await rpc(next.proc, next.input);
      if (next.proc === "threads/stop") continue;
      // `threads/get` não tem limite por minuto (apps/api/src/rate-limit.ts), então o
      // laço simples basta; o stream de eventos exigiria o cliente oRPC.
      for (let tick = 0; tick < 600; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        snapshot = await rpc("threads/get", { botId: bot.id, afterSeq: cursor });
        for (const message of snapshot.messages) console.log(renderMessage(message));
        cursor = snapshot.cursor;
        if (runIsOver(snapshot.run)) break;
      }
    }
  } finally {
    rl.close();
  }
}

// Só corre quando é ele o script chamado: os testes importam os auxiliares acima.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
