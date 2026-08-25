import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
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

interface DesktopBox {
  ref: ComputerRef;
  home: string;
  userId: string;
  grants: string[];
  running: boolean;
  screen: string;
}

export class DesktopSandboxProvider implements SandboxProvider {
  readonly boxes = new Map<string, DesktopBox>();

  constructor(
    private readonly opts: {
      root?: string;
      grants?: string[];
      grantsByUser?: Record<string, string[]>;
    } = {},
  ) {}

  describe() {
    return {
      id: "desktop",
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

  async provision(
    request: { botId: string; homePath: string; providerRef?: string; display?: number },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const id = `desktop-${request.botId}-${randomUUID().slice(0, 8)}`;
    const home = path.resolve(
      this.opts.root ?? path.join(process.cwd(), "data"),
      "desktop-computers",
      request.botId,
    );
    await mkdir(home, { recursive: true });
    const ref: ComputerRef = { id, botId: request.botId, kind: "desktop", providerRef: home };
    this.boxes.set(id, {
      ref,
      home,
      userId: context.userId,
      grants: [
        ...(this.opts.grants ?? []),
        ...(this.opts.grantsByUser?.[context.userId] ?? []),
        home,
      ],
      running: true,
      screen: "ready",
    });
    return ref;
  }

  addGrant(userId: string, folder: string) {
    const resolved = path.resolve(folder);
    this.opts.grantsByUser ??= {};
    this.opts.grantsByUser[userId] = [
      ...new Set([...(this.opts.grantsByUser[userId] ?? []), resolved]),
    ];
    for (const box of this.boxes.values()) {
      if (box.userId === userId && !box.grants.includes(resolved)) box.grants.push(resolved);
    }
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    _context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const box = this.boxes.get(computer.id);
    if (!box) {
      yield { type: "stderr", data: "computer not found" };
      yield { type: "exit", code: 1 };
      return;
    }
    const cwd = request.cwd ? path.resolve(box.home, request.cwd) : box.home;
    if (!allowedPath(cwd, box.grants)) {
      yield { type: "stderr", data: "path is not granted" };
      yield { type: "exit", code: 1 };
      return;
    }
    await mkdir(cwd, { recursive: true });
    const argv = request.argv.length ? request.argv : ["echo", "ready"];
    // This provider is a local UI adapter, not an OS sandbox. Never pass agent
    // commands to the service host. A tiny synthetic echo keeps health and
    // adapter-conformance probes useful without creating host execution.
    if (argv[0] !== "echo") {
      yield { type: "stderr", data: "host command execution is disabled" };
      yield { type: "exit", code: 126 };
      return;
    }
    yield { type: "stdout", data: `${argv.slice(1).join(" ")}\n` };
    yield { type: "exit", code: 0 };
  }

  async connectScreen(
    computer: ComputerRef,
    _request: ScreenRequest,
    _context: AdapterContext,
  ): Promise<ScreenSession> {
    return {
      url: `desktop://screen/${computer.id}`,
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
    const box = this.boxes.get(computer.id);
    if (box && input.kind === "clipboard") box.screen = input.text;
  }

  async snapshot(computer: ComputerRef, _context: AdapterContext) {
    return { id: `desktop-snap-${computer.id}`, createdAt: new Date().toISOString() };
  }

  async stop(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const box = this.boxes.get(computer.id);
    if (box) box.running = false;
  }

  async destroy(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const box = this.boxes.get(computer.id);
    this.boxes.delete(computer.id);
    if (box && this.opts.root) {
      await writeFile(path.join(box.home, ".stopped"), new Date().toISOString(), "utf8").catch(
        () => undefined,
      );
    }
    if (box && !this.opts.root) {
      await rm(box.home, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function allowedPath(target: string, grants: string[]) {
  const resolved = path.resolve(target);
  return grants.some((grant) => {
    const root = path.resolve(grant);
    return resolved === root || resolved.startsWith(root + path.sep);
  });
}
