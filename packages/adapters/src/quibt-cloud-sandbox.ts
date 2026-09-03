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
import { boundedSandboxCommandTimeoutMs, screenUrlFromQuibtCloudConnection } from "@quibt/core";
import {
  createQuibtCloudClient,
  isQuibtCloudLimitError,
  type QuibtCloudClient,
  QuibtCloudApiError,
  QuibtCloudLimitError,
  QuibtCloudSession,
} from "./quibt-cloud-client.js";

export interface QuibtCloudSandboxOptions {
  apiUrl?: string;
  token?: string;
  client?: QuibtCloudClient;
  fetchImpl?: typeof fetch;
}

/**
 * Computer provider backed by a Quibt Bot Cloud account.
 *
 * Provision/start/stop talk only to the isolated Cloud client. The live screen
 * reuses the same noVNC URL path as VPS/Box once `/api/boxes/:id/connection`
 * returns host/port/credential (or a ready `screenUrl`).
 *
 * REVIEW: `POST /api/boxes/:id/commands` is an optional hypothesized extension
 * used only for `execute`. The documented Cloud contract does not include it
 * yet; a 404 becomes a clear stderr line instead of a crash.
 */
export class QuibtCloudSandboxProvider implements SandboxProvider {
  private readonly client: QuibtCloudClient;
  private readonly session: QuibtCloudSession;
  private readonly screenUrls = new Map<string, string>();

  constructor(options: QuibtCloudSandboxOptions = {}) {
    this.client =
      options.client ??
      createQuibtCloudClient({
        baseUrl: options.apiUrl,
        token: options.token,
        fetchImpl: options.fetchImpl,
      });
    this.session = new QuibtCloudSession(this.client);
  }

  describe() {
    return {
      id: "quibt-cloud",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        agentInput: false,
        pty: true,
        snapshots: false,
        takeover: true,
        persistentHome: true,
      },
    };
  }

  async provision(
    request: { botId: string; homePath: string; providerRef?: string; display?: number },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    void context;
    const boxId = await this.ensureBox(request.providerRef);
    await this.session.resume(boxId);
    return this.toRef(boxId, request.botId);
  }

  async start(computer: ComputerRef, context: AdapterContext): Promise<ComputerRef> {
    void context;
    const boxId = computer.providerRef || computer.id;
    await this.session.resume(boxId);
    return this.toRef(boxId, computer.botId);
  }

  async stop(computer: ComputerRef, context: AdapterContext): Promise<void> {
    void context;
    const boxId = computer.providerRef || computer.id;
    this.screenUrls.delete(boxId);
    await this.session.stop(boxId);
  }

  async destroy(computer: ComputerRef, context: AdapterContext): Promise<void> {
    await this.stop(computer, context);
  }

  async presence(computer: ComputerRef, _context: AdapterContext): Promise<ComputerPresence> {
    const boxId = computer.providerRef || computer.id;
    const boxes = await this.client.listBoxes();
    const box = boxes.find((entry) => entry.id === boxId);
    if (!box) return "missing";
    return box.status === "running" ? "running" : "stopped";
  }

  async exists(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    return (await this.presence(computer, context)) !== "missing";
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    void context;
    const boxId = computer.providerRef || computer.id;
    const command = commandFromArgv(request.argv, request.cwd);
    const run = this.client.runCommand;
    if (!run) {
      yield {
        type: "stderr",
        data: "Este client Cloud não implementa comandos. REVIEW: POST /api/boxes/:id/commands.\n",
      };
      yield { type: "exit", code: 1 };
      return;
    }
    try {
      const result = await run(
        boxId,
        command,
        Math.max(1, Math.ceil(boundedSandboxCommandTimeoutMs(request.timeoutMs) / 1000)),
      );
      if (result.stdout) yield { type: "stdout", data: result.stdout };
      if (result.stderr) yield { type: "stderr", data: result.stderr };
      yield { type: "exit", code: result.exitCode };
    } catch (error) {
      if (isQuibtCloudLimitError(error)) {
        yield { type: "stderr", data: `${error.limit.upgradeMessage}\n` };
        yield { type: "exit", code: 1 };
        return;
      }
      if (error instanceof QuibtCloudApiError && error.status === 404) {
        yield {
          type: "stderr",
          data: "A API Cloud hipotética ainda não expõe POST /api/boxes/:id/commands. Ligar, desligar e a tela usam o contrato documentado.\n",
        };
        yield { type: "exit", code: 1 };
        return;
      }
      yield { type: "stderr", data: `${error instanceof Error ? error.message : error}\n` };
      yield { type: "exit", code: 1 };
    }
  }

  async connectScreen(
    computer: ComputerRef,
    _request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    void context;
    const boxId = computer.providerRef || computer.id;
    const connection = await this.session.connection(boxId);
    const url = screenUrlFromQuibtCloudConnection(connection);
    if (url) this.screenUrls.set(boxId, url);
    return {
      url: url ?? computer.screenUrl ?? this.screenUrls.get(boxId) ?? null,
      mimeType: "text/html",
      reason: url
        ? undefined
        : connection.protocol === "ssh"
          ? "A conexão Cloud veio como SSH sem URL de tela. REVIEW: o contrato hipotético ainda não define o túnel noVNC nesse caso."
          : "A Cloud não devolveu host/porta nem screenUrl para a tela.",
      close: async () => undefined,
    };
  }

  async sendInput(
    _computer: ComputerRef,
    _input: ComputerInput,
    _lease: ControlLeaseRef,
    _context: AdapterContext,
  ): Promise<void> {
    // Same as Box: takeover is the interactive noVNC desktop itself.
  }

  async snapshot(computer: ComputerRef, _context: AdapterContext) {
    return {
      id: `quibt-cloud-${computer.providerRef || computer.id}`,
      createdAt: new Date().toISOString(),
    };
  }

  private async ensureBox(preferred?: string): Promise<string> {
    const snap = await this.session.refresh();
    if (preferred) {
      const existing = snap.boxes.find((box) => box.id === preferred);
      if (existing) return existing.id;
    }
    const running = snap.boxes.find((box) => box.status === "running");
    if (running) return running.id;
    const stopped = snap.boxes.find((box) => box.status === "stopped");
    if (stopped) return stopped.id;
    throw new Error(
      "A conta Cloud ainda não tem nenhuma box. Crie uma no painel do Quibt Bot Cloud e tente de novo.",
    );
  }

  private toRef(boxId: string, botId: string): ComputerRef {
    const screenUrl = this.screenUrls.get(boxId);
    return {
      id: boxId,
      botId,
      kind: "quibt-cloud",
      providerRef: boxId,
      ...(screenUrl ? { screenUrl } : {}),
    };
  }
}

function commandFromArgv(argv: string[], cwd?: string): string {
  const inner =
    argv.length === 3 &&
    (argv[0] === "bash" || argv[0] === "sh") &&
    (argv[1] === "-lc" || argv[1] === "-c") &&
    typeof argv[2] === "string"
      ? argv[2]
      : argv.join(" ");
  if (!cwd) return inner;
  return `cd ${shellQuote(cwd)} && ${inner}`;
}

function shellQuote(part: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(part)) return part;
  return `'${part.replace(/'/g, "'\\''")}'`;
}

export { QuibtCloudLimitError };
