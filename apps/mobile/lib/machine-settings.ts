export {
  type MachineProbeResult,
  machineActivationGate,
  splitMachineCatalog,
} from "@quibt/core";

/** Reuse the Box key protected during server installation unless it is replaced here. */
export function effectiveMachineApiKey(
  kind: string,
  typedKey: string,
  savedBoxKey: string | null,
): string {
  const typed = typedKey.trim();
  if (typed) return typed;
  return kind === "box" ? (savedBoxKey?.trim() ?? "") : "";
}
