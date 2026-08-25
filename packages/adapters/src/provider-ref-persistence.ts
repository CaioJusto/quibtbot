import type { ComputerRef } from "@quibt/adapter-kit";
import { providerRefsFor } from "./workspace-computer.js";

export type SavedProviderRefs = {
  computerProviderRef: string | null;
  desktopProviderRef: string;
};

export function savedProviderRefsFromProvision(
  ref: Pick<ComputerRef, "kind" | "providerRef">,
): SavedProviderRefs {
  return providerRefsFor(ref.kind, ref.providerRef);
}

export function computerRunningDataFromProvision(ref: Pick<ComputerRef, "kind" | "providerRef">) {
  const refs = providerRefsFor(ref.kind, ref.providerRef);
  return {
    state: "running" as const,
    kind: ref.kind,
    providerRef: refs.computerProviderRef,
  };
}

export function desktopRunningDataFromProvision(
  ref: Pick<ComputerRef, "kind" | "providerRef" | "screenUrl" | "display">,
  existing: { display?: number | null },
  extra?: Partial<{ controlHolder: "bot" }>,
) {
  const refs = providerRefsFor(ref.kind, ref.providerRef);
  const display = ref.display ?? existing.display;
  return {
    state: "running" as const,
    providerRef: refs.desktopProviderRef,
    screenUrl: ref.screenUrl,
    ...(display != null ? { display } : {}),
    ...extra,
  };
}
