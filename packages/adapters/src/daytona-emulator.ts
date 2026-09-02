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
import { FakeSandboxProvider } from "./fake-sandbox.js";
import type { PortableHomeEntry } from "./workspace-checkpoint.js";

/** Local, per-bot Daytona stand-in for conformance tests without a live key. */
export class DaytonaSandboxEmulator implements SandboxProvider {
  private readonly inner = new FakeSandboxProvider({ scope: "bot" });
  readonly dest = this.inner.boxes;

  describe() {
    return {
      id: "daytona-emulator",
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

  provision(
    request: { botId: string; homePath: string; providerRef?: string; display?: number },
    context: AdapterContext,
  ) {
    return this.inner
      .provision(request, context)
      .then((ref) => ({ ...ref, kind: "daytona" as const }));
  }

  execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    return this.inner.execute(computer, request, context);
  }

  connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    return this.inner.connectScreen(computer, request, context);
  }

  sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    return this.inner.sendInput(computer, input, lease, context);
  }

  snapshot(computer: ComputerRef, context: AdapterContext) {
    return this.inner.snapshot(computer, context);
  }

  stop(computer: ComputerRef, context: AdapterContext) {
    return this.inner.stop(computer, context);
  }

  destroy(computer: ComputerRef, context: AdapterContext) {
    return this.inner.destroy(computer, context);
  }

  collectPortableHome(computer: ComputerRef, context: AdapterContext) {
    return this.inner.collectPortableHome(computer, context);
  }

  applyPortableHome(computer: ComputerRef, entries: PortableHomeEntry[], context: AdapterContext) {
    return this.inner.applyPortableHome(computer, entries, context);
  }
}
