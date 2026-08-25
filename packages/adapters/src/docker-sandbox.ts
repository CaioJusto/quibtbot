import type {
  AdapterContext,
  CommandRequest,
  ComputerInput,
  ComputerPresence,
  ComputerRef,
  ControlLeaseRef,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
} from "@quibt/adapter-kit";
import { boundedSandboxCommandTimeoutMs, resolveSupervisorToken } from "@quibt/core";

const SUPERVISOR_REQUEST_TIMEOUT_MS = 30_000;
/** Extra time for the supervisor to return after it has already killed the command. */
const SUPERVISOR_EXEC_MARGIN_MS = 10_000;
/** Religar refaz as conferências do provision (permissões da casa inteira): pode demorar. */
const SUPERVISOR_START_TIMEOUT_MS = 90_000;

function requestSignal(parent: AbortSignal, timeoutMs = SUPERVISOR_REQUEST_TIMEOUT_MS) {
  return AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
}

/**
 * The supervisor answers 403 "missing computer identity" when the bot header is absent, so
 * the header is never dropped: the ref carries the bot, and the context is the fallback.
 */
export function computerIdentity(
  computer: { botId?: string },
  context: { botId?: string },
): string | undefined {
  return context.botId || computer.botId || undefined;
}

/** Códigos que o supervisor manda junto do erro (`supervisor-core.ts`). */
export type SupervisorErrorCode = "computer-stopped" | "docker-down";

const SUPERVISOR_ERROR_CODES: ReadonlySet<string> = new Set(["computer-stopped", "docker-down"]);

function isSupervisorErrorCode(value: unknown): value is SupervisorErrorCode {
  return typeof value === "string" && SUPERVISOR_ERROR_CODES.has(value);
}

/** Supervisor statuses carry a meaning now (400/403/404/409); keep it in the message. */
export function supervisorErrorMessage(action: string, status: number, detail = ""): string {
  const parsed = parseSupervisorErrorBody(detail);
  // Com código, a mensagem já é a que a pessoa deve ler: "sandbox exec failed: 503"
  // não diz a ninguém para abrir o Docker.
  if (parsed.code) return computerErrorMessage(parsed.code, parsed.message);
  const reason =
    status === 400
      ? "invalid request"
      : status === 403
        ? "missing or mismatched computer identity"
        : status === 404
          ? "computer or session not found"
          : status === 409
            ? "the display is already taken"
            : "supervisor error";
  const tail = parsed.message.slice(0, 240);
  return `sandbox ${action} failed: ${status} ${reason}${tail ? ` (${tail})` : ""}`;
}

/** O corpo de erro do supervisor é `{ error, code? }`; texto solto também vale. */
export function parseSupervisorErrorBody(detail: string): {
  message: string;
  code?: SupervisorErrorCode;
} {
  const raw = detail.trim();
  if (!raw) return { message: "" };
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; code?: unknown };
    const message = typeof parsed.error === "string" ? parsed.error.trim() : "";
    const code = isSupervisorErrorCode(parsed.code) ? parsed.code : undefined;
    if (message || code) return code ? { message, code } : { message };
  } catch {
    /* not json */
  }
  return { message: raw };
}

/**
 * Uma chamada ao supervisor que não deu certo, com o status e o código que ele devolveu.
 * O roteador e o sono por ociosidade olham o status (404 em `stop` é "já está parado");
 * `publicComputerBootMessage` olha o código.
 */
export class SupervisorRequestError extends Error {
  readonly action: string;
  readonly status: number;
  readonly code: SupervisorErrorCode | undefined;
  /** O que o supervisor disse, já sem o envelope JSON. */
  readonly detail: string;

  constructor(action: string, status: number, body = "") {
    super(supervisorErrorMessage(action, status, body));
    const parsed = parseSupervisorErrorBody(body);
    this.name = "SupervisorRequestError";
    this.action = action;
    this.status = status;
    this.code = parsed.code;
    this.detail = parsed.message;
  }
}

/** O que o bot lê no stderr quando um comando religou o computador que estava parado. */
export const COMPUTER_REVIVED_NOTE =
  "O computador estava desligado e foi religado. As janelas abertas antes se perderam; os arquivos da pasta de casa continuam lá.";

const PUBLIC_COMPUTER_MESSAGE = /^O (computador|Docker)\b/;

/**
 * Mensagem para a pessoa, por código. O supervisor atual já manda a frase pronta
 * ("estava desligado e não conseguiu religar: abra o Docker"); a padrão cobre um
 * supervisor que só mandou o código, ou nada.
 */
export function computerErrorMessage(code: SupervisorErrorCode, detail = ""): string {
  const body = detail.trim();
  if (body && PUBLIC_COMPUTER_MESSAGE.test(body)) return body.slice(0, 280);
  if (code === "docker-down") {
    return "O computador não respondeu: o Docker não está rodando. Abra o Docker e tente de novo.";
  }
  return "O computador está desligado. Abra a tela do bot ou mande um comando para religar.";
}

/**
 * "Parar" o que o provedor já não tem — container parado depois de um reboot, bot que
 * nunca abriu a tela — é parar. Quem manda parar quer o banco dizendo "desligado", não um
 * erro; era o 404 subindo daqui que deixava o botão "Desligar" sem efeito.
 */
export function isComputerAlreadyStoppedError(error: unknown): boolean {
  if (error instanceof SupervisorRequestError) {
    return error.status === 404 || error.code === "computer-stopped";
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /^sandbox \w+ failed: 404\b/.test(message);
}

/** O supervisor não tem esse computador (ou não tem a rota: supervisor antigo numa VPS). */
export function isComputerMissingError(error: unknown): boolean {
  return error instanceof SupervisorRequestError && error.status === 404;
}

/** What the owner should read when computer.boot throws. */
export function publicComputerBootMessage(error: unknown): string {
  if (error instanceof SupervisorRequestError && error.code) {
    return computerErrorMessage(error.code, error.detail);
  }
  const raw = error instanceof Error ? error.message : String(error);
  if (/resource temporarily unavailable|eagain|RLIMIT_NPROC/i.test(raw)) {
    return "O computador não ligou: o Docker recusou o processo (EAGAIN). Tente de novo.";
  }
  const inner = raw.match(/\((.+)\)\s*$/);
  const body = (inner?.[1] ?? raw).trim();
  if (/O computador/i.test(body)) return body.slice(0, 280);
  if (/sandbox provision failed/i.test(raw)) {
    return `O computador não ligou. ${body.slice(0, 220)}`;
  }
  return (body || "Não foi possível ligar o computador.").slice(0, 280);
}

export class DockerSandboxProvider implements SandboxProvider {
  private readonly supervisorToken: string;
  private readonly kind: "docker" | "remote-supervisor";

  constructor(
    private readonly supervisorUrl: string,
    supervisorToken?: string,
    kind: "docker" | "remote-supervisor" = "docker",
  ) {
    this.supervisorToken = supervisorToken ?? resolveSupervisorToken(process.env);
    this.kind = kind;
  }

  describe() {
    return {
      id: this.kind,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: true,
        snapshots: true,
        takeover: true,
        persistentHome: true,
      },
    };
  }

  private url(path: string) {
    return `${this.supervisorUrl.replace(/\/$/, "")}${path}`;
  }

  private headers(context: AdapterContext, botId?: string) {
    return {
      authorization: `Bearer ${this.supervisorToken}`,
      "x-quibt-workspace-id": context.workspaceId,
      ...(botId ? { "x-quibt-bot-id": botId } : {}),
    };
  }

  async provision(
    request: { botId: string; homePath: string; providerRef?: string; display?: number },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const res = await fetch(this.url("/computers"), {
      method: "POST",
      headers: {
        ...this.headers(context, computerIdentity(request, context)),
        "content-type": "application/json",
      },
      // `homePath` is still required by the supervisor schema but it is NOT honoured: the
      // supervisor mounts `workspaceHomePath(dataDir, workspaceId)`, which it computes
      // itself. The client does not pick the mounted directory.
      body: JSON.stringify({
        botId: request.botId,
        homePath: request.homePath,
        workspaceId: context.workspaceId,
        display: request.display,
      }),
      signal: requestSignal(context.signal),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new SupervisorRequestError("provision", res.status, detail);
    }
    const body = (await res.json()) as { id: string; display?: number; screenUrl?: string };
    return {
      id: body.id,
      botId: request.botId,
      kind: this.kind,
      providerRef: body.id,
      display: body.display,
      screenUrl: body.screenUrl,
    };
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const res = await fetch(this.url(`/computers/${computer.id}/exec`), {
      method: "POST",
      headers: {
        ...this.headers(context, computerIdentity(computer, context)),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...request,
        cwd: request.cwd ?? "/home/quibt",
        timeoutMs: boundedSandboxCommandTimeoutMs(request.timeoutMs),
      }),
      signal: requestSignal(
        context.signal,
        boundedSandboxCommandTimeoutMs(request.timeoutMs) + SUPERVISOR_EXEC_MARGIN_MS,
      ),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      yield { type: "stderr", data: supervisorErrorMessage("exec", res.status, detail) };
      yield { type: "exit", code: 1 };
      return;
    }
    const body = (await res.json()) as {
      stdout: string;
      stderr: string;
      code: number;
      /** O container estava parado e o supervisor o religou antes de rodar. */
      revived?: boolean;
      /** O comando nem rodou: o supervisor diz por quê, com código. */
      errorCode?: string;
    };
    if (isSupervisorErrorCode(body.errorCode)) {
      yield { type: "stderr", data: computerErrorMessage(body.errorCode, body.stderr) };
      yield { type: "exit", code: body.code || 1 };
      return;
    }
    // O bot precisa saber que as janelas de antes se foram, senão insiste numa aba que
    // não existe mais.
    if (body.revived) yield { type: "stderr", data: `${COMPUTER_REVIVED_NOTE}\n` };
    if (body.stdout) yield { type: "stdout", data: body.stdout };
    if (body.stderr) yield { type: "stderr", data: body.stderr };
    yield { type: "exit", code: body.code };
  }

  async connectScreen(
    computer: ComputerRef,
    _request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    const res = await fetch(this.url(`/computers/${computer.id}`), {
      headers: this.headers(context, computerIdentity(computer, context)),
      signal: requestSignal(context.signal),
    });
    if (!res.ok) {
      return { url: null, mimeType: "text/html", close: async () => undefined };
    }
    const body = (await res.json()) as { screenUrl?: string };
    return {
      url: body.screenUrl ?? this.url(`/computers/${computer.id}/screen`),
      mimeType: "text/html",
      close: async () => undefined,
    };
  }

  /**
   * O banco pode dizer "running" de um container que não existe mais (imagem nova,
   * `docker rm`) ou que só está parado (reboot, `docker stop`). Só o 404 do supervisor
   * prova que sumiu; `running:false` é "parado", e dá para religar no lugar com `start`.
   * Qualquer outra resposta (ou nenhuma) é "unknown", para um soluço de rede ou um Docker
   * fechado não derrubar uma sessão boa — nem virar um provision que esbarraria na mesma
   * parede.
   */
  async presence(computer: ComputerRef, context: AdapterContext): Promise<ComputerPresence> {
    try {
      // Rota de existência, não a da tela: aquela exige identidade de bot e devolvia 403
      // quando o boot perguntava pelo workspace inteiro — e 403 passava por "existe".
      const res = await fetch(this.url(`/computers/${computer.id}/exists`), {
        headers: this.headers(context, computerIdentity(computer, context)),
        signal: requestSignal(context.signal),
      });
      if (res.status === 404) return "missing";
      if (!res.ok) return "unknown";
      const body = (await res.json().catch(() => ({}))) as { running?: unknown };
      if (body.running === true) return "running";
      if (body.running === false) return "stopped";
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  /** Parado também tira do atalho "já está ligado": o boot precisa religar antes. */
  async exists(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    const presence = await this.presence(computer, context);
    return presence !== "missing" && presence !== "stopped";
  }

  /**
   * Religa o container do workspace que está `Exited`, sem trocá-lo: mesma casa, mesmo id.
   * Um supervisor antigo (VPS que não atualizou) responde 404 aqui; quem chama cai então
   * no caminho de provisionar, que também retoma um container existente.
   */
  async start(computer: ComputerRef, context: AdapterContext): Promise<ComputerRef> {
    const res = await fetch(this.url(`/computers/${computer.id}/start`), {
      method: "POST",
      headers: this.headers(context, computerIdentity(computer, context)),
      signal: requestSignal(context.signal, SUPERVISOR_START_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new SupervisorRequestError("start", res.status, detail);
    }
    const body = (await res.json()) as { id: string };
    return { ...computer, id: body.id, providerRef: body.id };
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    const res = await fetch(this.url(`/computers/${computer.id}/input`), {
      method: "POST",
      headers: {
        ...this.headers(context, computerIdentity(computer, context)),
        "content-type": "application/json",
      },
      body: JSON.stringify({ input, leaseId: lease.leaseId }),
      signal: requestSignal(context.signal),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new SupervisorRequestError("input", res.status, detail);
    }
  }

  async snapshot(computer: ComputerRef, _context: AdapterContext) {
    return { id: `docker-snap-${computer.id}`, createdAt: new Date().toISOString() };
  }

  /**
   * Heartbeat / takeover ask the supervisor to inspect the session. That probe
   * restarts a wedged noVNC so the signed capability the API just issued is not
   * a black 502.
   */
  async keepAlive(computer: ComputerRef, context?: AdapterContext): Promise<void> {
    if (!context?.workspaceId) return;
    await fetch(this.url(`/computers/${computer.id}`), {
      headers: this.headers(context, computerIdentity(computer, context)),
      signal: requestSignal(context.signal),
    }).catch(() => undefined);
  }

  async stop(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const res = await fetch(this.url(`/computers/${computer.id}/stop`), {
      method: "POST",
      headers: this.headers(context, computerIdentity(computer, context)),
      signal: requestSignal(context.signal),
    });
    // 404 é "container parado" ou "bot sem tela": para quem manda parar, já está parado.
    // O supervisor atual responde `alreadyStopped`; um antigo, numa VPS, ainda dá 404.
    if (res.status === 404) return;
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new SupervisorRequestError("stop", res.status, detail);
    }
  }

  async destroy(computer: ComputerRef, context: AdapterContext): Promise<void> {
    await this.destroyBotSession(computer, context, { preserveComputer: false });
  }

  async destroyBotSession(
    computer: ComputerRef,
    context: AdapterContext,
    options: { preserveComputer: boolean },
  ): Promise<void> {
    const res = await fetch(this.url(`/computers/${computer.id}`), {
      method: "DELETE",
      headers: {
        ...this.headers(context, computerIdentity(computer, context)),
        ...(options.preserveComputer ? { "x-quibt-preserve-computer": "true" } : {}),
      },
      signal: requestSignal(context.signal),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new SupervisorRequestError("destroy", res.status, detail);
    }
  }
}
