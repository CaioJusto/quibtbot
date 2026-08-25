import type { AdapterContext, ComputerRef, SandboxProvider } from "@quibt/adapter-kit";
import {
  isWorkspaceScopedSandbox,
  type SharedComputerSiblingActivity,
  shouldStopSharedComputer,
} from "./workspace-computer.js";

export type SandboxWithDestroySession = SandboxProvider & {
  destroyBotSession?: (
    computer: ComputerRef,
    context: AdapterContext,
    options: { preserveComputer: boolean },
  ) => Promise<void>;
};

/** True when a shared delete/stop should keep the workspace container running. */
export function shouldPreserveSharedComputer(
  kind: string,
  activity: SharedComputerSiblingActivity,
): boolean {
  if (!isWorkspaceScopedSandbox(kind)) return false;
  return !shouldStopSharedComputer({
    kind,
    ...activity,
    userHoldsControl: false,
  });
}

/** Provider-aware bot session teardown (full destroy for per-bot sandboxes). */
export async function destroyBotSessionForRef(
  sandbox: SandboxProvider,
  ref: ComputerRef,
  context: AdapterContext,
  options: { preserveComputer: boolean },
): Promise<void> {
  const provider = sandbox as SandboxWithDestroySession;
  if (provider.destroyBotSession) {
    await provider.destroyBotSession(ref, context, options);
    return;
  }
  if (options.preserveComputer) {
    await sandbox.stop(ref, context);
    return;
  }
  await sandbox.destroy(ref, context);
}
