import type { AdapterContext, ComputerRef, SandboxProvider } from "@quibt/adapter-kit";
import {
  isWorkspaceScopedSandbox,
  type SharedComputerSiblingActivity,
  shouldStopSharedComputer,
} from "./workspace-computer.js";

export type SandboxWithDestroySession = SandboxProvider & {
  destroyBotSession?: (
    computer: ComputerRef,
    context: AdapterContext,
    options: { preserveComputer: boolean },
  ) => Promise<void>;
};

/** True when a shared delete/stop should keep the workspace container running. */
export function shouldPreserveSharedComputer(
  kind: string,
  activity: SharedComputerSiblingActivity,
): boolean {
  if (!isWorkspaceScopedSandbox(kind)) return false;
  return !shouldStopSharedComputer({
    kind,
    ...activity,
    userHoldsControl: false,
  });
}

/** Status que significam "o provedor já não tem isso": o fim que o destroy pede. */
const ALREADY_GONE_STATUS: ReadonlySet<number> = new Set([404, 410]);

/**
 * Erro de verdade, mesmo que a mensagem tenha a palavra "found": rede fora, credencial
 * recusada, prazo estourado, 5xx. Vem antes da lista de "já não existe" de propósito.
 */
const REAL_PROVIDER_FAILURE =
  /fetch failed|econnrefused|econnreset|enotfound|eai_again|etimedout|epipe|socket hang up|unauthorized|forbidden|invalid api key|permission denied|authentication|timed?\s?out|docker-down|(?:failed:\s*)?\b(?:400|401|403|409|429|5\d\d)\b/i;

/** Como cada provedor diz "esse ref não existe mais" quando não há status para ler. */
const ALREADY_GONE_MESSAGE =
  /\bnot[\s_-]?found\b|no such (?:container|object|sandbox|box|computer|display)|does not exist|doesn'?t exist|already (?:removed|deleted|destroyed|gone|killed|stopped)|was (?:already )?killed|archived permanently|failed:\s(?:404|410)\b/i;

function providerErrorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function providerErrorStatus(error: unknown): number | undefined {
  const shape = error as { status?: unknown; statusCode?: unknown };
  const raw = typeof shape?.status === "number" ? shape.status : shape?.statusCode;
  return typeof raw === "number" ? raw : undefined;
}

function providerErrorText(error: unknown): string {
  const shape = error as { message?: unknown; code?: unknown };
  const message = error instanceof Error ? error.message : String(shape?.message ?? "");
  const code = typeof shape?.code === "string" ? shape.code : "";
  return `${message} ${code}`.trim();
}

/**
 * "Já não existe" é SUCESSO no caminho de exclusão.
 *
 * A exclusão é retomável: o retry re-chama o destroy com um providerRef que a passada
 * anterior já apagou. Sem isto, um provedor que devolve 404 deixa a intent pendente para
 * sempre — trocaríamos "não retoma" por "retoma e trava". Docker/supervisor e o emulador
 * já são idempotentes por dentro; Box e E2B falam por mensagem, e é ela que lemos aqui.
 * Erro de verdade (rede, credencial, 5xx) continua subindo: dar por encerrado o que não
 * terminou vaza um computador pago sem ninguém para cobrar de volta.
 */
export function isSandboxAlreadyGoneError(error: unknown): boolean {
  const chain = providerErrorChain(error);
  if (chain.length === 0) return false;
  const statuses = chain
    .map(providerErrorStatus)
    .filter((status): status is number => typeof status === "number");
  // Com status, ele manda: 404/410 é fim de linha, 401/403/5xx é falha de verdade.
  if (statuses.length > 0) return statuses.every((status) => ALREADY_GONE_STATUS.has(status));
  const text = chain.map(providerErrorText).join(" | ").trim();
  if (!text) return false;
  if (REAL_PROVIDER_FAILURE.test(text)) return false;
  return ALREADY_GONE_MESSAGE.test(text);
}

/**
 * Parar o que o provedor já não tem também atingiu o estado desejado.
 *
 * Este wrapper é compartilhado pelo caminho normal de idle e pelo reconciliador. Antes,
 * apenas o primeiro engolia o 404 do supervisor, e ainda por uma classificação estreita
 * que não reconhecia a mensagem real da Box (`... failed: 404 not found`).
 */
export async function stopSandboxUnlessAlreadyGone(
  sandbox: SandboxProvider,
  ref: ComputerRef,
  context: AdapterContext,
): Promise<void> {
  try {
    await sandbox.stop(ref, context);
  } catch (error) {
    if (!isSandboxAlreadyGoneError(error)) throw error;
  }
}

async function runProviderTeardown(
  sandbox: SandboxProvider,
  ref: ComputerRef,
  context: AdapterContext,
  options: { preserveComputer: boolean },
): Promise<void> {
  const provider = sandbox as SandboxWithDestroySession;
  if (provider.destroyBotSession) {
    await provider.destroyBotSession(ref, context, options);
    return;
  }
  if (options.preserveComputer) {
    await sandbox.stop(ref, context);
    return;
  }
  await sandbox.destroy(ref, context);
}

/** Provider-aware bot session teardown (full destroy for per-bot sandboxes). */
export async function destroyBotSessionForRef(
  sandbox: SandboxProvider,
  ref: ComputerRef,
  context: AdapterContext,
  options: { preserveComputer: boolean },
): Promise<void> {
  try {
    await runProviderTeardown(sandbox, ref, context, options);
  } catch (error) {
    // Retomada: o ref desta intent pode já ter saído na passada anterior.
    if (isSandboxAlreadyGoneError(error)) return;
    throw error;
  }
}
