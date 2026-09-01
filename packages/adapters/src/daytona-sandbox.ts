import { randomUUID } from "node:crypto";
import { Daytona } from "@daytona/sdk";
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
import { boundedSandboxCommandTimeoutMs } from "@quibt/core";
import { boxCommandFromArgv, shellQuote } from "./box-sandbox.js";

export const DAYTONA_NOVNC_PORT = 6080;
export const DAYTONA_SCREEN_TTL_SECONDS = 60 * 60;

const STARTED_STATES = new Set(["started"]);
const STOPPED_STATES = new Set(["stopped", "paused", "archived"]);
const MISSING_STATES = new Set(["destroyed", "destroying"]);

export interface DaytonaSandboxLike {
  id: string;
  state?: string;
  getUserHomeDir(): Promise<string | undefined>;
  process: {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ): Promise<{ exitCode: number; result: string }>;
    createSession(sessionId: string): Promise<void>;
    executeSessionCommand(
      sessionId: string,
      request: { command: string; runAsync?: boolean; suppressInputEcho?: boolean },
      timeout?: number,
    ): Promise<{ stdout?: string; stderr?: string; output?: string; exitCode?: number }>;
    deleteSession(sessionId: string): Promise<void>;
  };
  computerUse: {
    start(): Promise<unknown>;
    stop(): Promise<unknown>;
    keyboard: {
      press(key: string, modifiers?: string[]): Promise<void>;
      type(text: string, delay?: number): Promise<void>;
    };
    mouse: {
      getPosition(): Promise<{ x: number; y: number }>;
      move(x: number, y: number): Promise<unknown>;
      click(x: number, y: number, button?: string, double?: boolean): Promise<unknown>;
    };
    screenshot: {
      takeFullScreen(showCursor?: boolean): Promise<unknown>;
    };
  };
  getSignedPreviewUrl(
    port: number,
    expiresInSeconds?: number,
  ): Promise<{ url: string; token: string }>;
  expireSignedPreviewUrl(port: number, token: string): Promise<void>;
}

export interface DaytonaClientLike {
  create(
    params?: Record<string, unknown>,
    options?: { timeout?: number },
  ): Promise<DaytonaSandboxLike>;
  get(id: string): Promise<DaytonaSandboxLike>;
  start(sandbox: DaytonaSandboxLike, timeout?: number): Promise<void>;
  stop(sandbox: DaytonaSandboxLike): Promise<void>;
  delete(sandbox: DaytonaSandboxLike, timeout?: number, wait?: boolean): Promise<void>;
}

export interface DaytonaSandboxOptions {
  apiUrl?: string;
  target?: string;
  screenTtlSeconds?: number;
  /** Test seam. Production constructs the official SDK client. */
  client?: DaytonaClientLike;
}

export function daytonaCreateOptions(botId: string) {
  return {
    labels: { botId, quibt: "computer" },
    envVars: { VNC_RESOLUTION: "1280x800" },
    public: false,
    // Quibt's idle scheduler owns stop/start. Preserve the disk until bot deletion.
    autoStopInterval: 0,
    autoPauseInterval: 0,
    autoArchiveInterval: 0,
    autoDeleteInterval: -1,
  };
}

export function isUnrecoverableDaytonaError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /not found|does not exist|404|not_found|destroyed|gone/i.test(message);
}

export function daytonaNoVncUrl(signedPreviewUrl: string): string {
  const url = new URL(signedPreviewUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/vnc.html`;
  url.searchParams.set("autoconnect", "1");
  url.searchParams.set("resize", "scale");
  return url.toString();
}

/** One Daytona sandbox per bot, using the default image's VNC/computer-use stack. */
export class DaytonaSandboxProvider implements SandboxProvider {
  private readonly client: DaytonaClientLike;
  private readonly screenTtlSeconds: number;
  private readonly sandboxes = new Map<string, DaytonaSandboxLike>();
  private readonly screenTokens = new Map<string, Set<string>>();

  constructor(apiKey: string, options: DaytonaSandboxOptions = {}) {
    this.client =
      options.client ??
      (new Daytona({
        apiKey,
        ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
        ...(options.target ? { target: options.target } : {}),
      }) as unknown as DaytonaClientLike);
    this.screenTtlSeconds = Math.max(
      60,
      Math.min(24 * 60 * 60, options.screenTtlSeconds ?? DAYTONA_SCREEN_TTL_SECONDS),
    );
  }

  describe() {
    return {
      id: "daytona",
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

  async provision(
    request: { botId: string; homePath: string; providerRef?: string; display?: number },
    _context: AdapterContext,
  ): Promise<ComputerRef> {
    if (request.providerRef) {
      try {
        const sandbox = await this.getStarted(request.providerRef);
        await this.prepareDesktop(sandbox);
        return this.toRef(sandbox, request.botId);
      } catch (error) {
        this.sandboxes.delete(request.providerRef);
        if (!isUnrecoverableDaytonaError(error)) throw error;
      }
    }

    const sandbox = await this.client.create(daytonaCreateOptions(request.botId), { timeout: 120 });
    try {
      await this.prepareDesktop(sandbox);
    } catch (error) {
      await this.client.delete(sandbox, 60, true).catch(() => undefined);
      throw error;
    }
    this.sandboxes.set(sandbox.id, sandbox);
    return this.toRef(sandbox, request.botId);
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    if (context.signal.aborted) throw context.signal.reason;
    const sandbox = await this.sandbox(computer);
    const home = (await sandbox.getUserHomeDir().catch(() => undefined)) ?? "/home/daytona";
    const cwd = (request.cwd ?? home).replace(/^\/home\/quibt(?=\/|$)/, home);
    const environment = Object.entries(request.env ?? {})
      .map(([key, value]) => shellQuote(`${key}=${value}`))
      .join(" ");
    const command = boxCommandFromArgv(request.argv);
    const wrapped = `cd ${shellQuote(cwd)} && ${environment ? `env ${environment} ` : ""}${command}`;
    const timeoutMs = boundedSandboxCommandTimeoutMs(request.timeoutMs);
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const sessionId = `quibt-${randomUUID()}`;
    try {
      await sandbox.process.createSession(sessionId);
      const result = await sandbox.process.executeSessionCommand(
        sessionId,
        { command: wrapped, runAsync: false, suppressInputEcho: true },
        timeoutSeconds,
      );
      if (result.stdout) yield { type: "stdout", data: result.stdout };
      if (result.stderr) yield { type: "stderr", data: result.stderr };
      yield { type: "exit", code: result.exitCode ?? 0 };
    } catch (error) {
      if (isCommandTimeout(error)) {
        yield { type: "stderr", data: `command timed out after ${timeoutMs} ms\n` };
        yield { type: "exit", code: 124 };
        return;
      }
      throw error;
    } finally {
      await sandbox.process.deleteSession(sessionId).catch(() => undefined);
    }
  }

  async connectScreen(
    computer: ComputerRef,
    _request: ScreenRequest,
    _context: AdapterContext,
  ): Promise<ScreenSession> {
    const sandbox = await this.sandbox(computer);
    await sandbox.computerUse.start();
    const preview = await sandbox.getSignedPreviewUrl(DAYTONA_NOVNC_PORT, this.screenTtlSeconds);
    const tokens = this.screenTokens.get(sandbox.id) ?? new Set<string>();
    tokens.add(preview.token);
    this.screenTokens.set(sandbox.id, tokens);
    return {
      url: daytonaNoVncUrl(preview.url),
      mimeType: "text/html",
      close: async () => this.expireScreenToken(sandbox, preview.token),
    };
  }

  async revokeScreen(computer: ComputerRef): Promise<void> {
    const sandbox = await this.sandbox(computer).catch(() => undefined);
    if (!sandbox) return;
    const tokens = [...(this.screenTokens.get(sandbox.id) ?? [])];
    await Promise.all(tokens.map((token) => this.expireScreenToken(sandbox, token)));
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    _context: AdapterContext,
  ): Promise<void> {
    const sandbox = await this.sandbox(computer);
    if (input.kind === "key") {
      await sandbox.computerUse.keyboard.press(input.key, input.modifiers);
      return;
    }
    if (input.kind === "clipboard") {
      // The current SDK has no clipboard endpoint. Typing gives paste-like behavior.
      await sandbox.computerUse.keyboard.type(input.text);
      return;
    }
    if (input.type === "move") {
      await sandbox.computerUse.mouse.move(input.x, input.y);
    } else if (input.type === "moveRelative") {
      const current = await sandbox.computerUse.mouse.getPosition();
      await sandbox.computerUse.mouse.move(current.x + input.x, current.y + input.y);
    } else if (input.type !== "up") {
      await sandbox.computerUse.mouse.click(input.x, input.y, input.button ?? "left");
    }
  }

  async snapshot(computer: ComputerRef, _context: AdapterContext) {
    const sandbox = await this.sandbox(computer);
    await sandbox.computerUse.screenshot.takeFullScreen(true);
    return { id: `daytona-${sandbox.id}-${Date.now()}`, createdAt: new Date().toISOString() };
  }

  async exists(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    const presence = await this.presence(computer, context);
    return presence !== "missing" && presence !== "stopped";
  }

  async presence(computer: ComputerRef, _context: AdapterContext): Promise<ComputerPresence> {
    const id = computer.providerRef || computer.id;
    try {
      const sandbox = await this.client.get(id);
      if (STARTED_STATES.has(sandbox.state ?? "started")) return "running";
      if (STOPPED_STATES.has(sandbox.state ?? "")) return "stopped";
      if (MISSING_STATES.has(sandbox.state ?? "")) return "missing";
      return "unknown";
    } catch (error) {
      return isUnrecoverableDaytonaError(error) ? "missing" : "unknown";
    }
  }

  async start(computer: ComputerRef, _context: AdapterContext): Promise<ComputerRef> {
    const sandbox = await this.getStarted(computer.providerRef || computer.id);
    await this.prepareDesktop(sandbox);
    return this.toRef(sandbox, computer.botId);
  }

  async keepAlive(computer: ComputerRef): Promise<void> {
    await this.sandbox(computer);
  }

  async stop(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const id = computer.providerRef || computer.id;
    const sandbox = this.sandboxes.get(id) ?? (await this.client.get(id));
    await this.revokeScreen(computer).catch(() => undefined);
    await sandbox.computerUse.stop().catch(() => undefined);
    await this.client.stop(sandbox);
    this.sandboxes.delete(id);
  }

  async destroy(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const id = computer.providerRef || computer.id;
    const sandbox = this.sandboxes.get(id) ?? (await this.client.get(id).catch(() => undefined));
    this.screenTokens.delete(id);
    this.sandboxes.delete(id);
    if (!sandbox) return;
    await this.client.delete(sandbox, 60, true).catch((error) => {
      if (!isUnrecoverableDaytonaError(error)) throw error;
    });
  }

  private async sandbox(computer: ComputerRef): Promise<DaytonaSandboxLike> {
    return this.getStarted(computer.providerRef || computer.id);
  }

  private async getStarted(id: string): Promise<DaytonaSandboxLike> {
    const cached = this.sandboxes.get(id);
    if (cached) return cached;
    const sandbox = await this.client.get(id);
    if (!STARTED_STATES.has(sandbox.state ?? "started")) {
      await this.client.start(sandbox, 120);
      sandbox.state = "started";
    }
    this.sandboxes.set(id, sandbox);
    return sandbox;
  }

  private async prepareDesktop(sandbox: DaytonaSandboxLike): Promise<void> {
    await sandbox.computerUse.start();
    const home = (await sandbox.getUserHomeDir().catch(() => undefined)) ?? "/home/daytona";
    await sandbox.process
      .executeCommand(
        'for browser in google-chrome chromium chromium-browser firefox; do if command -v "$browser" >/dev/null 2>&1; then nohup "$browser" https://www.google.com >/tmp/quibt-browser.log 2>&1 & break; fi; done',
        home,
        undefined,
        10,
      )
      .catch(() => undefined);
    this.sandboxes.set(sandbox.id, sandbox);
  }

  private toRef(sandbox: DaytonaSandboxLike, botId: string): ComputerRef {
    return {
      id: sandbox.id,
      botId,
      kind: "daytona",
      providerRef: sandbox.id,
    };
  }

  private async expireScreenToken(sandbox: DaytonaSandboxLike, token: string): Promise<void> {
    await sandbox.expireSignedPreviewUrl(DAYTONA_NOVNC_PORT, token).catch(() => undefined);
    const tokens = this.screenTokens.get(sandbox.id);
    tokens?.delete(token);
    if (!tokens?.size) this.screenTokens.delete(sandbox.id);
  }
}

function isCommandTimeout(error: unknown): boolean {
  return error instanceof Error && /timed?\s*out|timeout/i.test(`${error.name} ${error.message}`);
}
