import type { BillingSnapshot } from "@quibt/contracts";
import * as SecureStore from "expo-secure-store";
import { defaultApiBase, type EndpointResult, normalizeApiBase } from "./endpoint";
import {
  clearEnrollmentToken,
  isTerminalEnrollmentSignupFailure,
  loadEnrollmentToken,
} from "./enrollment-store";
import { webOrigin } from "./origin";
import {
  clearSessionToken,
  loadSessionToken,
  saveSessionToken,
  tokenFromAuthResponse,
} from "./session";

const ENDPOINT_KEY = "quibt.api_base";
export const MOBILE_REQUEST_TIMEOUT_MS = 15_000;
export const MOBILE_RPC_RETRIES = 2;
export const MOBILE_RPC_RETRY_DELAY_MS = 400;

function isTransientStatus(status: number) {
  return status === 502 || status === 503 || status === 429;
}

function isTransientNetworkError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /network request failed|failed to fetch|networkerror|load failed/i.test(error.message);
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

let cachedApiBase: string | undefined;

export function currentApiBase() {
  return cachedApiBase ?? defaultApiBase();
}

export function isCustomApiBase() {
  return currentApiBase() !== defaultApiBase();
}

export async function loadApiBase() {
  try {
    const stored = await SecureStore.getItemAsync(ENDPOINT_KEY);
    if (stored) {
      const parsed = normalizeApiBase(stored);
      if (parsed.ok) {
        cachedApiBase = parsed.url;
        return cachedApiBase;
      }
    }
  } catch {
    // SecureStore is unavailable in some test / web hosts.
  }
  cachedApiBase = defaultApiBase();
  return cachedApiBase;
}

export async function saveApiBase(input: string): Promise<EndpointResult> {
  const parsed = normalizeApiBase(input);
  if (!parsed.ok) return parsed;
  if (parsed.url === defaultApiBase()) return resetApiBase();
  const previous = currentApiBase();
  await SecureStore.setItemAsync(ENDPOINT_KEY, parsed.url);
  cachedApiBase = parsed.url;
  if (parsed.url !== previous) await clearSessionToken();
  return parsed;
}

export async function resetApiBase(): Promise<EndpointResult> {
  const previous = currentApiBase();
  try {
    await SecureStore.deleteItemAsync(ENDPOINT_KEY);
  } catch {
    // ignore missing keys
  }
  const url = defaultApiBase();
  cachedApiBase = url;
  if (url !== previous) await clearSessionToken();
  return { ok: true, url };
}

export async function authHeaders(): Promise<Record<string, string>> {
  const token = await loadSessionToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export const SESSION_EXPIRED_MESSAGE = "Sessão expirada. Entre de novo.";
const SESSION_EXPIRED_CODE = "session_expired";

/**
 * A 401 means the stored token is already gone: retrying only produces the same failure.
 * Screens use `isSessionExpiredError` to stop what they are doing and send the user to the
 * login instead of reconnecting behind an error banner.
 */
function sessionExpiredError() {
  const error = new Error(SESSION_EXPIRED_MESSAGE) as Error & { code?: string };
  error.code = SESSION_EXPIRED_CODE;
  return error;
}

export function isSessionExpiredError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === SESSION_EXPIRED_CODE
  );
}

function authError(body: unknown, fallback: string) {
  if (typeof body === "object" && body && "message" in body) {
    return String((body as { message?: string }).message ?? fallback);
  }
  return fallback;
}

async function apiFetch(input: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MOBILE_RPC_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (init.signal?.aborted) controller.abort();
    else init.signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => controller.abort(), MOBILE_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(input, { ...init, signal: controller.signal });
      if (res.ok || !isTransientStatus(res.status) || attempt === MOBILE_RPC_RETRIES) {
        return res;
      }
      lastError = new Error(`HTTP ${res.status}`);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      if (controller.signal.aborted) {
        throw new Error("A conexão demorou demais. Verifique sua internet e tente novamente.");
      }
      if (!isTransientNetworkError(error) || attempt === MOBILE_RPC_RETRIES) throw error;
      lastError = error;
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onAbort);
    }
    await wait(MOBILE_RPC_RETRY_DELAY_MS * 2 ** attempt);
  }
  throw lastError instanceof Error ? lastError : new Error("A conexão falhou");
}

/**
 * Troca o código de uso único que veio no QR por uma sessão. É o que faz o celular
 * entrar direto: quem mostrou o QR já estava logado naquele computador. O código vale
 * dois minutos e só serve uma vez — depois disso o app cai no login normal.
 */
export async function claimPairToken(token: string): Promise<{ name?: string } | null> {
  const res = await apiFetch(`${currentApiBase()}/api/auth/one-time-token/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "quibt://" },
    body: JSON.stringify({ token }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  const session = tokenFromAuthResponse(res, body);
  if (!session) return null;
  await saveSessionToken(session);
  const user = (body as { user?: { name?: string } })?.user;
  return { name: user?.name };
}

/**
 * Entrar num aparelho novo com o código curto que outro aparelho já conectado mostra.
 * Sem e-mail, sem senha: a conta mora na máquina de quem instalou, e ter acesso a um
 * aparelho que já entrou é a prova que vale aqui.
 */
export type PairRequest = { requestId: string; secret: string };
export type PairOutcome =
  | { state: "pending" }
  | { state: "approved"; name: string }
  | { state: "denied" | "expired" | "unknown" };

/**
 * Digitar o código não entra: cria um pedido que aparece no computador para ser
 * aprovado. Assim, quem viu o código de longe — numa foto da tela, por cima do ombro —
 * ainda esbarra em quem está sentado na máquina.
 */
export async function requestSignInWithCode(code: string, device: string): Promise<PairRequest> {
  const res = await apiFetch(`${currentApiBase()}/api/pairing/claim`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "quibt://" },
    body: JSON.stringify({ code, device }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    requestId?: string;
    secret?: string;
    message?: string;
  };
  if (!res.ok || !body.requestId || !body.secret) {
    throw new Error(body.message || "Não foi possível entrar com esse código");
  }
  return { requestId: body.requestId, secret: body.secret };
}

/** Pergunta como ficou. A sessão é guardada aqui, e só quando vem aprovada. */
export async function pollPairRequest(request: PairRequest): Promise<PairOutcome> {
  const res = await apiFetch(`${currentApiBase()}/api/pairing/poll`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "quibt://" },
    body: JSON.stringify(request),
  });
  const body = (await res.json().catch(() => ({}))) as {
    state?: string;
    token?: string;
    name?: string;
    message?: string;
  };
  if (!res.ok) throw new Error(body.message || "Não foi possível confirmar a entrada");
  if (body.state === "approved" && body.token) {
    await saveSessionToken(body.token);
    return { state: "approved", name: body.name ?? "" };
  }
  if (body.state === "pending") return { state: "pending" };
  return { state: (body.state as "denied" | "expired" | "unknown") ?? "unknown" };
}

/** Um aparelho já conectado emite o código que o próximo vai digitar. */
export async function createPairingCode(): Promise<{ code: string; expiresAt: string }> {
  const res = await apiFetch(`${currentApiBase()}/api/pairing/code`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "quibt://", ...(await authHeaders()) },
    body: "{}",
  });
  const body = (await res.json().catch(() => ({}))) as {
    code?: string;
    expiresAt?: string;
    message?: string;
  };
  if (!res.ok || !body.code) throw new Error(body.message || "Não foi possível gerar o código");
  return { code: body.code, expiresAt: body.expiresAt ?? "" };
}

export async function signUp(input: { name: string; email?: string; password?: string }) {
  const enrollment = (await loadEnrollmentToken()).trim();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: "quibt://",
  };
  if (enrollment) headers["x-quibt-enrollment"] = enrollment;

  const res = await apiFetch(`${currentApiBase()}/api/auth/sign-up/email`, {
    method: "POST",
    headers,
    // Sem e-mail e sem senha quando o código da instalação já provou o controle:
    // o servidor inventa as duas coisas e ninguém precisa guardá-las.
    body: JSON.stringify({
      name: input.name,
      ...(input.email ? { email: input.email } : {}),
      ...(input.password ? { password: input.password } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (enrollment && isTerminalEnrollmentSignupFailure(res.status)) {
      await clearEnrollmentToken();
    }
    throw new Error(authError(body, "Não foi possível criar a conta"));
  }
  const token = tokenFromAuthResponse(res, body);
  if (!token) throw new Error("O cadastro não devolveu uma sessão");
  await saveSessionToken(token);
  if (enrollment) await clearEnrollmentToken();
}

/** Nome e/ou foto. A foto vai como data URL pequena (o celular já reduziu para 256 px). */
export async function updateProfile(patch: { name?: string; image?: string | null }) {
  const res = await apiFetch(`${currentApiBase()}/api/auth/update-user`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "quibt://",
      ...(await authHeaders()),
    },
    body: JSON.stringify(patch),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(authError(body, "Não foi possível salvar o perfil"));
}

export async function changePassword(currentPassword: string, newPassword: string) {
  const res = await apiFetch(`${currentApiBase()}/api/auth/change-password`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "quibt://",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(authError(body, "Não foi possível alterar a senha"));
}

export async function changeEmail(newEmail: string) {
  const res = await apiFetch(`${currentApiBase()}/api/auth/change-email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "quibt://",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ newEmail, callbackURL: `${webOrigin()}/account` }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(authError(body, "Não foi possível alterar o e-mail"));
}

export async function sendVerificationEmail(email: string) {
  const res = await apiFetch(`${currentApiBase()}/api/auth/send-verification-email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "quibt://",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ email, callbackURL: `${webOrigin()}/account` }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(authError(body, "Não foi possível enviar a verificação"));
}

/** Deletes the account and the workspace it owns, then drops the local session. */
export async function deleteAccount() {
  await rpc("account/delete");
  await clearSessionToken();
}

/**
 * Sair nunca falha: a sessão local some mesmo com o servidor fora do ar. O
 * pedido ao servidor é cortesia (invalida o token lá) e tem prazo curto —
 * antes ele esperava os 15 s de timeout com retentativas e o botão parecia morto.
 */
export async function signOut() {
  try {
    const headers = await authHeaders();
    await apiFetch(`${currentApiBase()}/api/auth/sign-out`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "quibt://", ...headers },
      signal: timeoutSignal(SIGN_OUT_TIMEOUT_MS),
    });
  } catch {
    // Sem servidor não há o que invalidar; a sessão local sai do mesmo jeito.
  } finally {
    await clearSessionToken().catch(() => undefined);
  }
}

export const SIGN_OUT_TIMEOUT_MS = 4_000;

/** `AbortSignal.timeout` não existe em todo runtime do RN; este faz o mesmo. */
export function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/** Espera no máximo `ms`; passado isso, resolve com `fallback` em vez de travar a tela. */
export function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export async function rpc<T>(
  proc: string,
  body: unknown = {},
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const res = await apiFetch(`${currentApiBase()}/rpc/${proc}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "quibt://",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ json: body }),
    signal: options.signal,
  });
  if (res.status === 401) {
    await clearSessionToken();
    throw sessionExpiredError();
  }
  const parsed = (await res.json().catch(() => ({}))) as {
    json?: T | RpcErrorJson;
    error?: RpcErrorJson;
  };
  if (!res.ok || parsed.error) {
    const payload = parsed.error ?? (isRpcErrorJson(parsed.json) ? parsed.json : undefined);
    const error = new Error(payload?.message ?? `rpc ${proc} failed`) as Error & {
      code?: string;
      data?: unknown;
    };
    error.code = planLimitCode(payload);
    error.data = payload?.data;
    throw error;
  }
  return parsed.json as T;
}

type RpcErrorJson = {
  message?: string;
  code?: string;
  data?: unknown;
};

function isRpcErrorJson(value: unknown): value is RpcErrorJson {
  return typeof value === "object" && value !== null && "message" in value;
}

function planLimitCode(error: RpcErrorJson | undefined): string | undefined {
  if (typeof error?.data === "object" && error.data !== null) {
    const code = (error.data as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return error?.code;
}

export type MobileCatalogItem = {
  slug: string;
  name: string;
  logo: string | null;
  connected: boolean;
  noAuth: boolean;
};

export type MobileConnection = {
  id: string;
  provider: string;
  displayName: string;
  status: "pending" | "connected" | "revoked" | "error";
  capabilities: string[];
  createdAt: string;
};

export type MobileBot = {
  id: string;
  name: string;
  preview: string;
  title: string;
  color?: string;
  shape?: string;
  status?: string;
  updatedAt?: string;
  pinned?: boolean;
  unread?: boolean;
  chiefOfStaff?: boolean;
  hidden?: boolean;
};

export type MobileGroupMember = {
  id: string;
  name: string;
  title?: string;
  color: string;
  shape?: string;
};

export type MobileGroup = {
  id: string;
  name: string;
  instructions?: string;
  members: MobileGroupMember[];
};

export type MobileRoutine = {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  active: boolean;
  notify: boolean;
};

export type MobileMessage = {
  id: string;
  role: "user" | "bot" | "system";
  blocks: Array<{
    kind: string;
    text?: string;
    state?: string;
    name?: string;
    task?: string;
    status?: string;
    progress?: string;
    result?: string;
    botId?: string;
    title?: string;
    tool?: string;
    /** What exactly the bot wants to run (the command, the path, the name). */
    detail?: string;
    answered?: string;
    allowKey?: string;
    actions?: Array<{ id: string; label: string }>;
    artifactId?: string;
    mimeType?: string;
    size?: number;
    image?: boolean;
    caption?: string;
  }>;
  runId?: string;
  /** Set when another bot wrote into this thread. */
  fromBotId?: string;
  /** In a group thread, the member that spoke. */
  authorBotId?: string;
  parentId?: string | null;
  replyToId?: string;
  reactions?: Record<string, string[]>;
  createdAt?: string;
  /** Present only while a just-sent message is waiting for its durable live event. */
  clientNonce?: string;
};

export type MobileGroupSnapshot = {
  groupId: string;
  threadId: string;
  cursor?: number;
  messages: MobileMessage[];
  runs?: Array<{ id: string; botId: string; status: string }>;
};

/** Loop another bot in, exactly as the web composer does on an @mention. */
export async function sendToPeer(fromBotId: string, toBotId: string, text: string) {
  await rpc("peers/send", { fromBotId, toBotId, text });
}

export async function getGroup(groupId: string) {
  return rpc<MobileGroup>("botGroups/get", { groupId });
}

export async function getGroupThread(groupId: string, afterSeq?: number) {
  return rpc<MobileGroupSnapshot>("botGroups/thread", { groupId, afterSeq });
}

/** Post into a group thread; the server decides which members wake up. */
export async function sendToGroup(
  groupId: string,
  text: string,
  mentionBotIds?: string[],
  clientNonce?: string,
) {
  return rpc<{ seq: number; runIds: string[] }>("botGroups/send", {
    groupId,
    text,
    clientNonce,
    mentionBotIds: mentionBotIds?.length ? mentionBotIds : undefined,
  });
}

export type MobileSnapshot = {
  botId: string;
  threadId: string;
  cursor?: number;
  messages: MobileMessage[];
  run: { status: string } | null;
  computer: { state: string; controlHolder: string; screenAvailable: boolean };
};

export function blockText(message: MobileMessage) {
  return message.blocks
    .map((block) => {
      if (block.kind === "subagent") {
        const status =
          block.status === "failed"
            ? "falhou"
            : block.status === "completed"
              ? "concluído"
              : "trabalhando…";
        const body = block.result || block.progress || "";
        return `**${block.name ?? "Subagente"}** (subagente, ${status})${body ? `\n${body}` : ""}`;
      }
      if (block.kind === "child_bot") {
        return block.status === "deleted"
          ? `Bot **${block.name ?? ""}** removido, incluindo chat, computador e memória.`
          : `Criou o bot **${block.name ?? ""}**${block.title ? ` — ${block.title}` : ""}. Ele aparece na sua lista.`;
      }
      if (block.kind === "ask") return askText(block);
      return block.text ?? block.state ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * O card de aprovação mostra o que vai rodar, não só "preciso da sua aprovação": sem o
 * comando à vista a pessoa aprova no escuro, e depois de respondido precisa ficar
 * registrado o que ela decidiu.
 */
export function askText(block: MobileMessage["blocks"][number]): string {
  const lines = [block.text ?? ""];
  if (block.detail) lines.push(`\`${block.detail.replace(/`/g, "'")}\``);
  if (block.answered) {
    lines.push(
      block.answered === "deny" || block.answered === "denied"
        ? "Recusado"
        : block.answered === "always"
          ? "Sempre permitido"
          : "Permitido",
    );
  }
  return lines.filter(Boolean).join("\n");
}

export type ThreadEvent = {
  id?: string;
  type: string;
  seq?: number;
  runId?: string;
  createdAt?: string;
  payload?: Record<string, unknown>;
};

export async function subscribeThread(
  botId: string,
  cursor: number,
  onEvent: (event: ThreadEvent) => void,
  signal: AbortSignal,
) {
  await subscribeEvents("threads/subscribe", { botId, cursor }, onEvent, signal);
}

export async function subscribeGroupThread(
  groupId: string,
  cursor: number,
  onEvent: (event: ThreadEvent) => void,
  signal: AbortSignal,
) {
  await subscribeEvents("botGroups/subscribe", { groupId, cursor }, onEvent, signal);
}

type StreamingFetch = (input: string, init: RequestInit) => Promise<Response>;

let streamingFetch: Promise<StreamingFetch> | undefined;

/**
 * React Native's built-in fetch has no `Response.body` stream, so SSE would silently fall
 * back to polling. Expo ships a WinterCG fetch with real streaming; load it lazily so tests
 * and the web target keep using the global one.
 */
function loadStreamingFetch(): Promise<StreamingFetch> {
  streamingFetch ??= (async () => {
    try {
      // On web this module is a thin wrapper over the global fetch.
      const expo = await import("expo/fetch");
      return (input, init) => expo.fetch(input, init as never) as unknown as Promise<Response>;
    } catch {
      return (input, init) => fetch(input, init);
    }
  })();
  return streamingFetch;
}

async function subscribeEvents(
  proc: string,
  input: Record<string, unknown>,
  onEvent: (event: ThreadEvent) => void,
  signal: AbortSignal,
) {
  const streamFetch = await loadStreamingFetch();
  let res: Response;
  try {
    res = await streamFetch(`${currentApiBase()}/rpc/${proc}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        origin: "quibt://",
        ...(await authHeaders()),
      },
      body: JSON.stringify({ json: input }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) return;
    throw error;
  }
  if (res.status === 401) {
    await clearSessionToken();
    throw sessionExpiredError();
  }
  if (!res.ok) throw new Error(`rpc ${proc} failed (${res.status})`);
  if (!res.body) throw new Error(`rpc ${proc} cannot stream on this device`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const data = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");
        if (!data || data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data) as { json?: ThreadEvent; error?: { message?: string } };
          if (parsed.json?.type) onEvent(parsed.json);
        } catch {
          // ignore keepalives and partial frames
        }
      }
    }
  } catch (error) {
    if (signal.aborted) return;
    throw error;
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

export function applyMobileThreadEvent<
  T extends { messages: MobileMessage[]; run?: unknown; cursor?: number },
>(prev: T | null, event: ThreadEvent): T | null {
  if (!prev) return prev;
  if (event.type === "thread.cleared") {
    return { ...prev, cursor: event.seq ?? prev.cursor, messages: [], run: null } as T;
  }
  if (event.type === "thread.progress") {
    const text = String(event.payload?.text ?? "");
    // One streaming bubble per run: in a group several members can be typing at once.
    const id = `progress:${event.runId ?? event.id ?? "live"}`;
    const streaming: MobileMessage = {
      id,
      role: "bot",
      blocks: [{ kind: "progress", text }],
      runId: event.runId,
      authorBotId:
        typeof event.payload?.authorBotId === "string" ? event.payload.authorBotId : undefined,
      replyToId: typeof event.payload?.replyToId === "string" ? event.payload.replyToId : undefined,
      createdAt:
        typeof event.payload?.createdAt === "string" ? event.payload.createdAt : event.createdAt,
    };
    return {
      ...prev,
      cursor: event.seq ?? prev.cursor,
      messages: [...prev.messages.filter((message) => message.id !== id), streaming],
    };
  }
  if (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled"
  ) {
    return {
      ...prev,
      cursor: event.seq ?? prev.cursor,
      run: null,
      messages: prev.messages.filter((message) => !message.id.startsWith("progress:")),
    } as T;
  }
  if (event.type === "thread.message.created") {
    const eventClientNonce =
      typeof event.payload?.clientNonce === "string" ? event.payload.clientNonce : undefined;
    const next: MobileMessage = {
      id: String(event.payload?.messageId ?? event.id ?? `msg:${event.seq ?? 0}`),
      role: (event.payload?.role as MobileMessage["role"]) ?? "bot",
      blocks: (event.payload?.blocks as MobileMessage["blocks"]) ?? [],
      runId: event.runId,
      fromBotId: typeof event.payload?.fromBotId === "string" ? event.payload.fromBotId : undefined,
      authorBotId:
        typeof event.payload?.authorBotId === "string" ? event.payload.authorBotId : undefined,
      createdAt: typeof event.payload?.createdAt === "string" ? event.payload.createdAt : undefined,
    };
    const finishedProgress = event.runId ? `progress:${event.runId}` : null;
    return {
      ...prev,
      cursor: event.seq ?? prev.cursor,
      messages: [
        ...prev.messages.filter(
          (message) =>
            message.id !== next.id &&
            (!eventClientNonce || message.clientNonce !== eventClientNonce) &&
            (finishedProgress
              ? message.id !== finishedProgress
              : !message.id.startsWith("progress:")),
        ),
        next,
      ],
    };
  }
  return prev;
}

export {
  apiBaseWarning,
  defaultApiBase,
  displayApiHost,
  normalizeApiBase,
  probeApiBase,
} from "./endpoint";
export type { BillingSnapshot };
export { loadSessionToken };
