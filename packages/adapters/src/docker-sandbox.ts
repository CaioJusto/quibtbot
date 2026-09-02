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
import {
  createSshDockerPort,
  rewriteScreenUrlToLoopback,
  type SshDockerPort,
  type SshLocalForward,
} from "./ssh-docker.js";

/** Tira a senha VNC do endereço remoto antes de gravar no banco. */
function persistedRemoteScreenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("password");
    const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ""));
    fragment.delete("password");
    parsed.hash = fragment.toString();
    return parsed.toString();
  } catch {
    return url;
  }
}

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

/**
 * Fallback de `revivedMessage`: um supervisor anterior a este manda só `revived:true`.
 * A frase de verdade vem do supervisor (`COMPUTER_REVIVED_MESSAGE`), para não haver duas
 * cópias vivas dela em pacotes diferentes.
 */
export const COMPUTER_REVIVED_NOTE =
  "O computador estava desligado e foi religado. As janelas abertas antes se perderam; os arquivos da pasta de casa continuam lá.";

/**
 * O supervisor roda dentro do Docker em todas as topologias do produto (app desktop,
 * compose, VPS): com o Docker fechado ele cai junto e ninguém atende a porta. O erro que
 * chega aqui é um `TypeError: fetch failed`, não um 503 com código — e sem esta frase o
 * bot recebia isso cru no stderr, e a pessoa via "computer request failed".
 */
export const SUPERVISOR_DOWN_MESSAGE =
  "O computador não respondeu: o Docker (ou o Quibt) não está rodando. Abra o Docker e tente de novo.";

/** EAGAIN é o mesmo diagnóstico venha por código ou por texto solto. */
const EAGAIN_MESSAGE = /resource temporarily unavailable|eagain|rlimit_nproc/i;

export const COMPUTER_EAGAIN_MESSAGE =
  "O computador não ligou: o Docker recusou o processo (EAGAIN). Tente de novo em instantes.";

/** Para o bot: ele não tem botão "Ligar" na tela, tem o terminal. */
const COMPUTER_STOPPED_FOR_BOT =
  "O computador estava desligado; rode um comando de terminal para religá-lo e abra a tela de novo antes de clicar.";

/** Para o dono: o botão está bem ali. */
const COMPUTER_STOPPED_FOR_PERSON = "O computador está desligado. Toque em Ligar.";

const PUBLIC_COMPUTER_MESSAGE = /^O (computador|Docker)\b/;

/**
 * "Só está desligado" não é diagnóstico nenhum: a frase certa depende de quem lê. Já
 * "não conseguiu religar: <motivo>" é diagnóstico e vale para os dois.
 */
const STOPPED_BOILERPLATE = /^O computador (está|estava) desligado[;.]/;

/** Quem vai ler a frase: o bot, pelo stderr, ou o dono, na tela. */
export type ComputerMessageAudience = "bot" | "person";

/**
 * Mensagem por código. O supervisor atual já manda a frase pronta ("estava desligado e
 * não conseguiu religar: abra o Docker") e ela passa direto; a padrão cobre um supervisor
 * que só mandou o código, ou nada, e aí a audiência decide.
 */
export function computerErrorMessage(
  code: SupervisorErrorCode,
  detail = "",
  audience: ComputerMessageAudience = "bot",
): string {
  const body = detail.trim();
  if (body && PUBLIC_COMPUTER_MESSAGE.test(body) && !STOPPED_BOILERPLATE.test(body)) {
    return body.slice(0, 280);
  }
  if (code === "docker-down") return SUPERVISOR_DOWN_MESSAGE;
  return audience === "person" ? COMPUTER_STOPPED_FOR_PERSON : COMPUTER_STOPPED_FOR_BOT;
}

const NETWORK_FAILURE_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** O supervisor não atendeu: porta fechada, nome que não resolve, ou nem respondeu a tempo. */
export function isSupervisorUnreachable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
  // `AbortSignal.timeout` rejeita com `TimeoutError`; um `AbortError` é cancelamento de
  // quem chamou, e esse não vira "abra o Docker".
  if (candidate.name === "TimeoutError") return true;
  for (const value of [candidate.code, (candidate.cause as { code?: unknown } | undefined)?.code]) {
    if (typeof value === "string" && NETWORK_FAILURE_CODES.has(value)) return true;
  }
  return (
    error instanceof TypeError && /fetch failed|failed to fetch/i.test(String(candidate.message))
  );
}

function supervisorDownError(action: string): SupervisorRequestError {
  return new SupervisorRequestError(
    action,
    503,
    JSON.stringify({ error: SUPERVISOR_DOWN_MESSAGE, code: "docker-down" }),
  );
}

/** O supervisor (ou o Docker embaixo dele) não está de pé. */
export function isComputerUnreachableError(error: unknown): boolean {
  return error instanceof SupervisorRequestError && error.code === "docker-down";
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
  const raw = error instanceof Error ? error.message : String(error);
  const detail = error instanceof SupervisorRequestError ? error.detail : "";
  if (/trial_auto_stop_required|free-trial boxes cannot run without auto-stop/i.test(raw)) {
    return "A sua conta Box está no trial e exige pausa automática. O Quibt usa o limite de 2 horas e preserva o disco para retomar depois.";
  }
  if (/^box api\b.*\b(?:401|403)\b/i.test(raw)) {
    return "A Box recusou a chave salva. Atualize a chave em Máquina dos bots e tente novamente.";
  }
  if (/^box api\b.*\b429\b/i.test(raw)) {
    return "A sua conta Box atingiu o limite de máquinas agora. Aguarde um pouco ou confira o plano da Box.";
  }
  if (/^box api\b/i.test(raw)) {
    return "A Box não conseguiu ligar este computador. Tente novamente; se continuar, confira a conta e a chave Box.";
  }
  // Antes do ramo por código: com `computer-stopped` a frase inteira do supervisor
  // passava e o dono lia "RLIMIT_NPROC do uid 1000 no host", que é recado de operador.
  if (EAGAIN_MESSAGE.test(detail) || EAGAIN_MESSAGE.test(raw)) return COMPUTER_EAGAIN_MESSAGE;
  if (error instanceof SupervisorRequestError && error.code) {
    return computerErrorMessage(error.code, error.detail, "person");
  }
  const inner = raw.match(/\((.+)\)\s*$/);
  const body = (inner?.[1] ?? raw).trim();
  if (/O computador/i.test(body)) return body.slice(0, 280);
  if (/sandbox provision failed/i.test(raw)) {
    return `O computador não ligou. ${body.slice(0, 220)}`;
  }
  return (body || "Não foi possível ligar o computador.").slice(0, 280);
}

export interface DockerSandboxExtras {
  sshAlias?: string;
  ssh?: SshDockerPort;
}

export class DockerSandboxProvider implements SandboxProvider {
  private readonly supervisorToken: string;
  private readonly kind: "docker" | "remote-supervisor";
  private readonly configuredSupervisorUrl: string;
  private readonly sshAlias: string | undefined;
  private readonly ssh: SshDockerPort | undefined;
  private resolvedSupervisorUrl: string | undefined;
  private readonly novncTunnels = new Map<string, SshLocalForward>();

  constructor(
    supervisorUrl = "http://127.0.0.1:7091",
    supervisorToken?: string,
    kind: "docker" | "remote-supervisor" = "docker",
    extras?: DockerSandboxExtras,
  ) {
    this.configuredSupervisorUrl = supervisorUrl;
    this.supervisorToken = supervisorToken ?? resolveSupervisorToken(process.env);
    this.kind = kind;
    this.sshAlias = extras?.sshAlias?.trim() || undefined;
    this.ssh = extras?.ssh ?? (this.sshAlias ? createSshDockerPort() : undefined);
  }

  describe() {
    return {
      id: this.kind,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        agentInput: true,
        pty: true,
        snapshots: true,
        takeover: true,
        persistentHome: true,
      },
    };
  }

  private url(path: string, base = this.resolvedSupervisorUrl ?? this.configuredSupervisorUrl) {
    return `${base.replace(/\/$/, "")}${path}`;
  }

  /**
   * No caminho SSH a URL do supervisor é um túnel em 127.0.0.1, aberto na primeira
   * chamada. Docker local e https remoto continuam com o endereço configurado.
   */
  private async ensureSupervisorUrl(): Promise<string> {
    if (!this.sshAlias || !this.ssh) return this.configuredSupervisorUrl;
    if (this.resolvedSupervisorUrl) return this.resolvedSupervisorUrl;
    const origin = await this.ssh.supervisorOrigin(this.sshAlias);
    this.resolvedSupervisorUrl = origin;
    return origin;
  }

  private headers(context: AdapterContext, botId?: string) {
    return {
      authorization: `Bearer ${this.supervisorToken}`,
      "x-quibt-workspace-id": context.workspaceId,
      ...(botId ? { "x-quibt-bot-id": botId } : {}),
    };
  }

  /**
   * O display que o banco guarda para este bot. O supervisor honra quando estiver livre:
   * é o que devolve ao bot o mesmo desktop — mesmo uid, mesma pasta 700, mesmo perfil do
   * Chromium — depois de o container voltar de um reboot com a memória zerada.
   */
  private displayHeader(computer: ComputerRef): Record<string, string> {
    const display = computer.display;
    if (typeof display !== "number" || !Number.isInteger(display) || display < 1) return {};
    return { "x-quibt-display": String(display) };
  }

  /**
   * `fetch` que traduz "ninguém atendeu" num erro com código, em vez de deixar um
   * `TypeError: fetch failed` subir cru. Nas topologias do produto o supervisor roda
   * dentro do Docker: Docker fechado é supervisor fechado, e quem precisa ler isso é a
   * pessoa que pode abrir o Docker.
   */
  private async call(
    action: string,
    path: string,
    init: RequestInit & { signal: AbortSignal },
    parent: AbortSignal,
  ): Promise<Response> {
    try {
      const base = await this.ensureSupervisorUrl();
      return await fetch(this.url(path, base), init);
    } catch (error) {
      // Cancelamento de quem chamou não é o Docker fechado.
      if (parent.aborted) throw error;
      if (isSupervisorUnreachable(error)) throw supervisorDownError(action);
      throw error;
    }
  }

  async provision(
    request: { botId: string; homePath: string; providerRef?: string; display?: number },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const res = await this.call(
      "provision",
      "/computers",
      {
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
      },
      context.signal,
    );
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
    let res: Response;
    try {
      res = await this.call(
        "exec",
        `/computers/${computer.id}/exec`,
        {
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
        },
        context.signal,
      );
    } catch (error) {
      // O comando não rodou porque não há computador de pé. O bot lê o motivo no stderr
      // e sai 1, em vez de a corrida inteira morrer com `TypeError: fetch failed`.
      if (!isComputerUnreachableError(error)) throw error;
      yield { type: "stderr", data: (error as Error).message };
      yield { type: "exit", code: 1 };
      return;
    }
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
      /** A frase que o supervisor quer que o bot leia sobre isso. */
      revivedMessage?: string;
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
    if (body.revived) {
      // A frase é do supervisor; a daqui só cobre um supervisor mais velho, que não manda.
      const note = body.revivedMessage?.trim() || COMPUTER_REVIVED_NOTE;
      yield { type: "stderr", data: `${note}\n` };
    }
    if (body.stdout) yield { type: "stdout", data: body.stdout };
    if (body.stderr) yield { type: "stderr", data: body.stderr };
    yield { type: "exit", code: body.code };
  }

  async connectScreen(
    computer: ComputerRef,
    _request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    const res = await this.call(
      "inspect",
      `/computers/${computer.id}`,
      {
        headers: {
          ...this.headers(context, computerIdentity(computer, context)),
          ...this.displayHeader(computer),
        },
        signal: requestSignal(context.signal),
      },
      context.signal,
    );
    if (!res.ok) {
      // Sem tela, mas com motivo: depois de religar, quem pediu precisa poder dizer por
      // que a tela não abriu em vez de repetir a URL de antes do reboot, que já morreu.
      const detail = await res.text().catch(() => "");
      return {
        url: null,
        mimeType: "text/html",
        reason: supervisorErrorMessage("inspect", res.status, detail),
        close: async () => undefined,
      };
    }
    const body = (await res.json()) as { screenUrl?: string };
    const remoteUrl = body.screenUrl ?? null;
    if (!remoteUrl) {
      return {
        url: null,
        mimeType: "text/html",
        reason: "O supervisor não devolveu um endereço seguro para a tela.",
        close: async () => undefined,
      };
    }
    if (this.sshAlias && this.ssh) {
      const tunnel = await this.ssh.openNovncTunnel(this.sshAlias, remoteUrl);
      const previous = this.novncTunnels.get(computer.id);
      this.novncTunnels.set(computer.id, tunnel);
      await previous?.close().catch(() => undefined);
      const persistedUrl = persistedRemoteScreenUrl(remoteUrl);
      return {
        url: rewriteScreenUrlToLoopback(remoteUrl, tunnel.origin),
        mimeType: "text/html",
        persistedUrl,
        close: async () => {
          await this.closeNovncTunnel(computer.id);
        },
      };
    }
    return {
      url: remoteUrl,
      mimeType: "text/html",
      close: async () => undefined,
    };
  }

  private async closeNovncTunnel(computerId: string): Promise<void> {
    const tunnel = this.novncTunnels.get(computerId);
    if (!tunnel) return;
    this.novncTunnels.delete(computerId);
    await tunnel.close().catch(() => undefined);
  }

  async getLoopbackPreview(
    computer: ComputerRef,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    const tunnel = this.novncTunnels.get(computer.id);
    if (!tunnel) return null;
    try {
      const res = await fetch(`${tunnel.origin}/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(4_000),
      });
      const contentType = res.headers.get("content-type") ?? "";
      if (!res.ok || !contentType.includes("image/")) return null;
      return { bytes: new Uint8Array(await res.arrayBuffer()), contentType };
    } catch {
      return null;
    }
  }

  async revokeScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    await this.closeNovncTunnel(computer.id);
    const res = await this.call(
      "revoke screen",
      `/computers/${computer.id}/screen/revoke`,
      {
        method: "POST",
        headers: {
          ...this.headers(context, computerIdentity(computer, context)),
          ...this.displayHeader(computer),
        },
        signal: requestSignal(context.signal),
      },
      context.signal,
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new SupervisorRequestError("revoke screen", res.status, detail);
    }
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
    return (await this.probePresence(computer, context)).presence;
  }

  /**
   * "unknown" tem dois sabores: o supervisor respondeu algo que não sabemos ler, e o
   * supervisor não respondeu nada. Só o segundo pode virar erro para a pessoa, então o
   * motivo volta junto em vez de ser engolido pelo `catch`.
   */
  private async probePresence(
    computer: ComputerRef,
    context: AdapterContext,
  ): Promise<{ presence: ComputerPresence; unreachable?: SupervisorRequestError }> {
    try {
      // Rota de existência, não a da tela: aquela exige identidade de bot e devolvia 403
      // quando o boot perguntava pelo workspace inteiro — e 403 passava por "existe".
      const res = await this.call(
        "exists",
        `/computers/${computer.id}/exists`,
        {
          headers: this.headers(context, computerIdentity(computer, context)),
          signal: requestSignal(context.signal),
        },
        context.signal,
      );
      if (res.status === 404) return { presence: "missing" };
      if (!res.ok) return { presence: "unknown" };
      const body = (await res.json().catch(() => ({}))) as { running?: unknown };
      if (body.running === true) return { presence: "running" };
      if (body.running === false) return { presence: "stopped" };
      return { presence: "unknown" };
    } catch (error) {
      if (isComputerUnreachableError(error)) {
        return { presence: "unknown", unreachable: error as SupervisorRequestError };
      }
      return { presence: "unknown" };
    }
  }

  /**
   * Parado também tira do atalho "já está ligado": o boot precisa religar antes. E um
   * supervisor que não atende não pode responder "sim, existe": era isso que fazia
   * `computer.boot` devolver "ligado" com a tela morta enquanto o Docker estava fechado.
   */
  async exists(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    const probe = await this.probePresence(computer, context);
    if (probe.unreachable) throw probe.unreachable;
    return probe.presence !== "missing" && probe.presence !== "stopped";
  }

  /**
   * Religa o container do workspace que está `Exited`, sem trocá-lo: mesma casa, mesmo id.
   * Um supervisor antigo (VPS que não atualizou) responde 404 aqui; quem chama cai então
   * no caminho de provisionar, que também retoma um container existente.
   */
  async start(computer: ComputerRef, context: AdapterContext): Promise<ComputerRef> {
    const res = await this.call(
      "start",
      `/computers/${computer.id}/start`,
      {
        method: "POST",
        headers: {
          ...this.headers(context, computerIdentity(computer, context)),
          ...this.displayHeader(computer),
        },
        signal: requestSignal(context.signal, SUPERVISOR_START_TIMEOUT_MS),
      },
      context.signal,
    );
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
    const res = await this.call(
      "input",
      `/computers/${computer.id}/input`,
      {
        method: "POST",
        headers: {
          ...this.headers(context, computerIdentity(computer, context)),
          ...this.displayHeader(computer),
          "content-type": "application/json",
        },
        body: JSON.stringify({ input, leaseId: lease.leaseId }),
        signal: requestSignal(context.signal),
      },
      context.signal,
    );
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
    const base = await this.ensureSupervisorUrl().catch(() => this.configuredSupervisorUrl);
    await fetch(this.url(`/computers/${computer.id}`, base), {
      headers: {
        ...this.headers(context, computerIdentity(computer, context)),
        ...this.displayHeader(computer),
      },
      signal: requestSignal(context.signal),
    }).catch(() => undefined);
  }

  async stop(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const res = await this.call(
      "stop",
      `/computers/${computer.id}/stop`,
      {
        method: "POST",
        headers: this.headers(context, computerIdentity(computer, context)),
        signal: requestSignal(context.signal),
      },
      context.signal,
    );
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
    const res = await this.call(
      "destroy",
      `/computers/${computer.id}`,
      {
        method: "DELETE",
        headers: {
          ...this.headers(context, computerIdentity(computer, context)),
          ...(options.preserveComputer ? { "x-quibt-preserve-computer": "true" } : {}),
        },
        signal: requestSignal(context.signal),
      },
      context.signal,
    );
    // Deleting is idempotent. Shared-workspace refs can outlive the container when another
    // bot's final teardown removed it first; that means the requested end state is reached.
    if (res.status === 404) return;
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new SupervisorRequestError("destroy", res.status, detail);
    }
  }
}
