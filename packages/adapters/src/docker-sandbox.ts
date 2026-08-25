import type {
  AdapterContext,
  CommandRequest,
  ComputerInput,
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

/** Supervisor statuses carry a meaning now (400/403/404/409); keep it in the message. */
export function supervisorErrorMessage(action: string, status: number, detail = ""): string {
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
  const inner = supervisorDetailMessage(detail);
  const tail = inner.slice(0, 240);
  return `sandbox ${action} failed: ${status} ${reason}${tail ? ` (${tail})` : ""}`;
}

function supervisorDetailMessage(detail: string): string {
  const raw = detail.trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
  } catch {
    /* not json */
  }
  return raw;
}

/** What the owner should read when computer.boot throws. */
export function publicComputerBootMessage(error: unknown): string {
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
      throw new Error(supervisorErrorMessage("provision", res.status, detail));
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
      yield { type: "stderr", data: supervisorErrorMessage("exec", res.status) };
      yield { type: "exit", code: 1 };
      return;
    }
    const body = (await res.json()) as { stdout: string; stderr: string; code: number };
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
   * O banco pode dizer "running" de um container que não existe mais: o app foi atualizado
   * (imagem nova, o supervisor recria o container), o Docker reiniciou, alguém deu `rm`.
   * Só o 404 do supervisor prova que ele sumiu; qualquer outra resposta (ou nenhuma) vale
   * como "ainda está lá", para um soluço de rede não derrubar uma sessão boa.
   */
  async exists(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    try {
      // Rota de existência, não a da tela: aquela exige identidade de bot e devolvia 403
      // quando o boot perguntava pelo workspace inteiro — e 403 passava por "existe".
      const res = await fetch(this.url(`/computers/${computer.id}/exists`), {
        headers: this.headers(context, computerIdentity(computer, context)),
        signal: requestSignal(context.signal),
      });
      return res.status !== 404;
    } catch {
      // Rede caída ou supervisor reiniciando não é prova de que o computador sumiu:
      // afirmar isso destruiria a linha e provisionaria outro por engano.
      return true;
    }
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
      throw new Error(supervisorErrorMessage("input", res.status, detail));
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
    if (!res.ok) throw new Error(supervisorErrorMessage("stop", res.status));
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
    if (!res.ok) throw new Error(supervisorErrorMessage("destroy", res.status));
  }
}
