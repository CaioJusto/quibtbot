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
import {
  applyToFileMap,
  collectFromFileMap,
  type PortableHomeEntry,
  portableHomeLayout,
} from "./workspace-checkpoint.js";

export interface FakeBox {
  ref: ComputerRef;
  files: Map<string, string>;
  running: boolean;
  screen: string;
  workspaceId: string;
  display: number;
}

export interface FakeSandboxOptions {
  scope?: "workspace" | "bot";
}

export class FakeSandboxProvider implements SandboxProvider {
  readonly boxes = new Map<string, FakeBox>();
  readonly workspaceFiles = new Map<string, Map<string, string>>();
  private readonly botFiles = new Map<string, Map<string, string>>();
  private readonly scope: "workspace" | "bot";

  constructor(options: FakeSandboxOptions = {}) {
    this.scope = options.scope ?? "workspace";
  }

  describe() {
    return {
      id: "fake",
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

  private refId(workspaceId: string, botId: string) {
    return this.scope === "bot" ? `fake-${workspaceId}-${botId}` : `fake-${workspaceId}`;
  }

  private filesFor(workspaceId: string, botId: string) {
    if (this.scope === "bot") {
      const key = `${workspaceId}:${botId}`;
      const existing = this.botFiles.get(key);
      if (existing) return existing;
      const created = new Map<string, string>();
      this.botFiles.set(key, created);
      return created;
    }
    const existing = this.workspaceFiles.get(workspaceId);
    if (existing) return existing;
    const created = new Map<string, string>();
    this.workspaceFiles.set(workspaceId, created);
    return created;
  }

  async provision(
    request: { botId: string; homePath: string; providerRef?: string; display?: number },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    if (request.providerRef) {
      const resumed = [...this.boxes.values()].find(
        (box) =>
          box.ref.providerRef === request.providerRef && box.workspaceId === context.workspaceId,
      );
      if (resumed) {
        resumed.running = true;
        resumed.files = this.filesFor(context.workspaceId, request.botId);
        return resumed.ref;
      }
    }
    const id = this.refId(context.workspaceId, request.botId);
    const key = `${id}:${request.botId}`;
    const existing = this.boxes.get(key);
    if (existing) {
      existing.running = true;
      existing.files = this.filesFor(context.workspaceId, request.botId);
      return existing.ref;
    }
    const display = request.display ?? this.nextDisplay(context.workspaceId);
    const ref: ComputerRef = {
      id,
      botId: request.botId,
      kind: "fake",
      providerRef: id,
      display,
      screenUrl: `fake://screen/${context.workspaceId}/${request.botId}`,
    };
    this.boxes.set(key, {
      ref,
      files: this.filesFor(context.workspaceId, request.botId),
      running: true,
      screen: "ready",
      workspaceId: context.workspaceId,
      display,
    });
    return ref;
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    _context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const box = this.box(computer, _context);
    if (!box) {
      yield { type: "stderr", data: "computer not found" };
      yield { type: "exit", code: 1 };
      return;
    }
    const cmd = request.argv.join(" ");
    const written = /(?:echo|printf)\s+(?:'%s'\s+)?(.+?)\s+>\s+(\S+)/.exec(cmd);
    if (written) {
      const content = written[1]?.replace(/^['"]|['"]$/g, "") ?? "";
      const file = written[2] ?? "";
      box.files.set(file, `${content}\n`);
      yield { type: "exit", code: 0 };
      return;
    }
    if (request.argv[0] === "echo") {
      yield { type: "stdout", data: `${request.argv.slice(1).join(" ")}\n` };
    } else if (request.argv[0] === "cat" || cmd.startsWith("cat ")) {
      const file = request.argv[request.argv[0] === "cat" ? 1 : 1] ?? "";
      yield { type: "stdout", data: box.files.get(file) ?? "" };
    } else {
      yield { type: "stdout", data: `ran ${cmd}\n` };
    }
    yield { type: "exit", code: 0 };
  }

  async connectScreen(
    computer: ComputerRef,
    _request: ScreenRequest,
    _context: AdapterContext,
  ): Promise<ScreenSession> {
    return {
      url: computer.screenUrl ?? `fake://screen/${computer.id}/${computer.botId}`,
      mimeType: "text/plain",
      close: async () => undefined,
    };
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    _context: AdapterContext,
  ): Promise<void> {
    const box = this.box(computer, _context);
    if (box && input.kind === "clipboard") box.screen = input.text;
  }

  async snapshot(computer: ComputerRef, _context: AdapterContext) {
    return { id: `snap-${computer.id}`, createdAt: new Date().toISOString() };
  }

  async stop(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const box = this.box(computer, _context);
    if (box) box.running = false;
  }

  async destroy(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    this.boxes.delete(`${computer.id}:${computer.botId}`);
    if (this.scope === "bot") {
      this.botFiles.delete(`${_context.workspaceId}:${computer.botId}`);
    }
  }

  async destroyBotSession(
    computer: ComputerRef,
    context: AdapterContext,
    options: { preserveComputer: boolean },
  ): Promise<void> {
    if (options.preserveComputer) {
      await this.stop(computer, context);
      return;
    }
    await this.destroy(computer, context);
  }

  async collectPortableHome(
    computer: ComputerRef,
    context: AdapterContext,
  ): Promise<PortableHomeEntry[]> {
    const box = this.box(computer, context);
    if (!box) return [];
    return collectFromFileMap(box.files, portableHomeLayout(computer.kind, computer.botId));
  }

  async applyPortableHome(
    computer: ComputerRef,
    entries: PortableHomeEntry[],
    context: AdapterContext,
  ): Promise<void> {
    const box = this.box(computer, context);
    if (!box) return;
    applyToFileMap(box.files, portableHomeLayout(computer.kind, computer.botId), entries);
  }

  session(computer: ComputerRef) {
    return this.boxes.get(`${computer.id}:${computer.botId}`);
  }

  private box(computer: ComputerRef, context: AdapterContext) {
    return (
      this.boxes.get(`${computer.id}:${computer.botId}`) ??
      [...this.boxes.values()].find(
        (box) => box.ref.botId === computer.botId && box.workspaceId === context.workspaceId,
      )
    );
  }

  private nextDisplay(workspaceId: string) {
    const used = new Set(
      [...this.boxes.values()]
        .filter((box) => box.workspaceId === workspaceId)
        .map((box) => box.display),
    );
    let display = 1;
    while (used.has(display)) display += 1;
    return display;
  }
}
