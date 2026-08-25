export const INSTALL_STEPS = [
  "requirements",
  "environment",
  "images",
  "services",
  "database",
  "health",
  "pairing",
] as const;

export type InstallStep = (typeof INSTALL_STEPS)[number];

export interface InstallState {
  version: 1;
  release: string;
  completed: InstallStep[];
  updatedAt: string;
}

export function nextInstallStep(state: InstallState): InstallStep | null {
  return INSTALL_STEPS.find((step) => !state.completed.includes(step)) ?? null;
}
