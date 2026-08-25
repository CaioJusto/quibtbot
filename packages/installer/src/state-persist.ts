import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { INSTALL_RELEASE } from "./compose.js";
import type { InstallState, InstallStep } from "./state.js";
import {
  classifyInstallStateForInstall,
  classifyInstallStateForUpdate,
  classifyInstallStateReadOnly,
  type InstallStateValidation,
  isEmbeddedTrustedRelease,
  validateInstallState,
} from "./state-validation.js";

export {
  classifyInstallState,
  classifyInstallStateForInstall,
  classifyInstallStateForUpdate,
  classifyInstallStateReadOnly,
  type InstallStateValidation,
  inspectInstallStateStructure,
  isEmbeddedTrustedRelease,
  isInstallStateComplete,
  validateInstallState,
} from "./state-validation.js";

export function installStatePath(dataDir: string): string {
  return path.join(path.resolve(dataDir), "install-state.json");
}

export function quarantineStatePath(dataDir: string, stamp: string): string {
  return path.join(path.resolve(dataDir), `install-state.quarantined.${stamp}.json`);
}

function quarantineCorruptState(dataDir: string, onWarning?: (message: string) => void): void {
  const target = installStatePath(dataDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantined = quarantineStatePath(dataDir, stamp);
  try {
    renameSync(target, quarantined);
    onWarning?.(
      `Install state was invalid and moved to ${quarantined}. Starting from a clean state.`,
    );
  } catch {
    // ignore
  }
}

export function loadInstallState(
  dataDir: string,
  onWarning?: (message: string) => void,
): InstallState | null {
  const target = installStatePath(dataDir);
  if (!existsSync(target)) return null;
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8")) as unknown;
    const classified = classifyInstallStateForInstall(parsed);
    if (classified.ok) return classified.state;
    if (classified.reason === "update_required") return null;
    quarantineCorruptState(dataDir, onWarning);
    return null;
  } catch {
    quarantineCorruptState(dataDir, onWarning);
    return null;
  }
}

export function loadInstallStateForUpdate(dataDir: string): InstallState | null {
  const target = installStatePath(dataDir);
  if (!existsSync(target)) return null;
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8")) as unknown;
    const classified = classifyInstallStateForUpdate(parsed);
    return classified.ok ? classified.state : null;
  } catch {
    return null;
  }
}

export function inspectInstallState(
  dataDir: string,
): InstallStateValidation | { ok: true; state: null } {
  const target = installStatePath(dataDir);
  if (!existsSync(target)) return { ok: true, state: null };
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8")) as unknown;
    return classifyInstallStateReadOnly(parsed);
  } catch {
    return { ok: false, reason: "corrupt", message: "Install state is corrupt or unreadable." };
  }
}

export function saveInstallState(dataDir: string, state: InstallState): void {
  const validated = validateInstallState(state);
  if (!validated) {
    throw new Error("refusing to save invalid install state");
  }
  mkdirSync(path.resolve(dataDir), { recursive: true, mode: 0o700 });
  const target = installStatePath(dataDir);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, target);
}

export function initialInstallState(release = INSTALL_RELEASE, now = new Date()): InstallState {
  if (!isEmbeddedTrustedRelease(release)) {
    throw new Error(`refusing to create install state for non-embedded release ${release}`);
  }
  return {
    version: 1,
    release,
    completed: [],
    updatedAt: now.toISOString(),
  };
}

export function completeInstallStep(
  state: InstallState,
  step: InstallStep,
  now = new Date(),
): InstallState {
  if (state.completed.includes(step)) return state;
  return {
    ...state,
    completed: [...state.completed, step],
    updatedAt: now.toISOString(),
  };
}
