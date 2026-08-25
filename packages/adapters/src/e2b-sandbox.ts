import { Sandbox } from "@e2b/desktop";
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
import { boundedSandboxCommandTimeoutMs } from "@quibt/core";
import { boxCommandFromArgv } from "./box-sandbox.js";
import { sandboxIdleMs } from "./computer-idle.js";

export function e2bCreateOptions(botId: string, apiKey: string) {
  return {
    apiKey,
    timeoutMs: sandboxIdleMs(),
    metadata: { botId, quibt: "computer" },
    resolution: [1280, 800] as [number, number],
    lifecycle: { onTimeout: "pause" as const, autoResume: false },
  };
}

export function isUnrecoverableSandboxError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|does not exist|404|not_found|killed|doesn't exist|sandbox not found/i.test(
    message,
  );
}

export const E2B_BROWSER_APPS = ["google-chrome", "firefox", "chromium"] as const;

export async function openDesktopBrowser(desktop: {
  launch: (application: string, uri?: string) => Promise<void>;
  open: (fileOrUrl: string) => Promise<void>;
}): Promise<void> {
  for (const app of E2B_BROWSER_APPS) {
    try {
      await desktop.launch(app);
      return;
    } catch {
      // try the next installed browser
    }
  }
  await desktop.open("https://www.google.com").catch(() => undefined);
}

/**
 * Anything that fails between `Sandbox.create` and the returned `ComputerRef` leaks a
 * running (billed) sandbox: nobody else holds its id, so nothing would ever stop it.
 */
export async function preparedOrKilled<T extends { kill(): Promise<unknown> }>(
  desktop: T,
  prepare: (desktop: T) => Promise<void>,
): Promise<T> {
  try {
    await prepare(desktop);
    return desktop;
  } catch (error) {
    await desktop.kill().catch(() => undefined);
    throw error;
  }
}

export class E2BSandboxProvider implements SandboxProvider {
  private readonly boxes = new Map<string, Sandbox>();

  constructor(private readonly apiKey: string) {}

  describe() {
    return {
      id: "e2b",
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

  private async box(computer: ComputerRef): Promise<Sandbox> {
    const id = computer.providerRef || computer.id;
    const existing = this.boxes.get(id);
    if (existing) {
      await existing.setTimeout(sandboxIdleMs()).catch(() => undefined);
      return existing;
    }
    const connected = await Sandbox.connect(id, {
      apiKey: this.apiKey,
      timeoutMs: sandboxIdleMs(),
    });
    await this.startStream(connected);
    this.boxes.set(connected.sandboxId, connected);
    return connected;
  }

  private async startStream(desktop: Sandbox) {
    await desktop.stream.start({ requireAuth: true }).catch(() => desktop.stream.start());
  }

  async provision(
    request: { botId: string; homePath: string; providerRef?: string; display?: number },
    _context: AdapterContext,
  ): Promise<ComputerRef> {
    if (request.providerRef) {
      try {
        const desktop = await Sandbox.connect(request.providerRef, {
          apiKey: this.apiKey,
          timeoutMs: sandboxIdleMs(),
        });
        await this.startStream(desktop);
        this.boxes.set(desktop.sandboxId, desktop);
        return {
          id: desktop.sandboxId,
          botId: request.botId,
          kind: "e2b",
          providerRef: desktop.sandboxId,
        };
      } catch (error) {
        this.boxes.delete(request.providerRef);
        if (!isUnrecoverableSandboxError(error)) throw error;
      }
    }
    const desktop = await preparedOrKilled(
      await Sandbox.create(e2bCreateOptions(request.botId, this.apiKey)),
      async (box) => {
        await box.files.makeDir("/home/user/quibt-home").catch(() => undefined);
        await this.startStream(box);
        await openDesktopBrowser(box);
      },
    );
    this.boxes.set(desktop.sandboxId, desktop);
    return {
      id: desktop.sandboxId,
      botId: request.botId,
      kind: "e2b",
      providerRef: desktop.sandboxId,
    };
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const desktop = await this.box(computer);
    const cmd = boxCommandFromArgv(request.argv);
    // The executor defaults cwd to /home/quibt (the docker image's home); the
    // e2b desktop image's home is /home/user, so remap that prefix.
    const cwd = (request.cwd ?? "/home/user").replace(/^\/home\/quibt(?=\/|$)/, "/home/user");
    const timeoutMs = boundedSandboxCommandTimeoutMs(request.timeoutMs);
    try {
      const result = await desktop.commands.run(cmd, {
        cwd,
        signal: context.signal,
        timeoutMs,
      });
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
    }
  }

  async connectScreen(
    computer: ComputerRef,
    _request: ScreenRequest,
    _context: AdapterContext,
  ): Promise<ScreenSession> {
    const desktop = await this.box(computer);
    let authKey: string | undefined;
    try {
      authKey = desktop.stream.getAuthKey();
    } catch {
      authKey = undefined;
    }
    const url =
      typeof desktop.stream.getUrl === "function"
        ? desktop.stream.getUrl({
            autoConnect: true,
            resize: "scale",
            ...(authKey ? { authKey } : {}),
          })
        : null;
    return {
      url,
      mimeType: "text/html",
      close: async () => {
        await desktop.stream.stop().catch(() => undefined);
      },
    };
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    _context: AdapterContext,
  ): Promise<void> {
    const desktop = await this.box(computer);
    if (input.kind === "key") {
      await desktop.press(input.key);
    } else if (input.kind === "pointer") {
      if (input.type === "move") await desktop.moveMouse(input.x, input.y);
      else if (input.type === "click" || input.type === "down") {
        if (input.button === "right") await desktop.rightClick(input.x, input.y);
        else await desktop.leftClick(input.x, input.y);
      }
    } else if (input.kind === "clipboard") {
      await desktop.write(input.text);
    }
  }

  async snapshot(computer: ComputerRef, _context: AdapterContext) {
    const desktop = await this.box(computer);
    await desktop.screenshot().catch(() => undefined);
    return { id: `e2b-${computer.id}-${Date.now()}`, createdAt: new Date().toISOString() };
  }

  async keepAlive(computer: ComputerRef): Promise<void> {
    await this.box(computer);
  }

  async stop(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const id = computer.providerRef || computer.id;
    const desktop = this.boxes.get(id);
    this.boxes.delete(id);
    if (desktop) {
      await desktop.pause().catch(() => undefined);
      return;
    }
    await Sandbox.pause(id, { apiKey: this.apiKey }).catch(() => undefined);
  }

  async destroy(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const desktop = await this.box(computer).catch(() => undefined);
    await desktop?.kill();
    this.boxes.delete(computer.providerRef || computer.id);
  }
}

function isCommandTimeout(error: unknown) {
  return error instanceof Error && /timed?\s*out|timeout/i.test(`${error.name} ${error.message}`);
}
