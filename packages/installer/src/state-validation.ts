import { INSTALL_RELEASE } from "./compose.js";
import { parseStrictSemver } from "./semver.js";
import { INSTALL_STEPS, type InstallState, type InstallStep } from "./state.js";

export type InstallStateValidation =
  | { ok: true; state: InstallState }
  | { ok: false; reason: "corrupt"; message: string }
  | { ok: false; reason: "update_required"; release: string; message: string };

export function isEmbeddedTrustedRelease(release: string): boolean {
  return release === INSTALL_RELEASE;
}

function hasStructuralInstallState(raw: unknown): raw is InstallState {
  if (!raw || typeof raw !== "object") return false;
  const state = raw as InstallState;
  if (state.version !== 1) return false;
  if (!parseStrictSemver(state.release)) return false;
  if (!state.updatedAt || Number.isNaN(Date.parse(state.updatedAt))) return false;
  if (!Array.isArray(state.completed)) return false;

  const seen = new Set<InstallStep>();
  for (const step of state.completed) {
    if (!INSTALL_STEPS.includes(step)) return false;
    if (seen.has(step)) return false;
    seen.add(step);
  }

  for (let index = 0; index < state.completed.length; index += 1) {
    if (state.completed[index] !== INSTALL_STEPS[index]) return false;
  }

  return true;
}

export function inspectInstallStateStructure(
  raw: unknown,
): { ok: true; state: InstallState } | { ok: false; reason: "corrupt"; message: string } {
  if (!hasStructuralInstallState(raw)) {
    return { ok: false, reason: "corrupt", message: "Install state is corrupt or unreadable." };
  }
  return { ok: true, state: raw as InstallState };
}

export function classifyInstallStateForInstall(raw: unknown): InstallStateValidation {
  const structural = inspectInstallStateStructure(raw);
  if (!structural.ok) return structural;

  const state = structural.state;
  if (!isEmbeddedTrustedRelease(state.release)) {
    return {
      ok: false,
      reason: "update_required",
      release: state.release,
      message: `Installed release ${state.release} does not match embedded installer release ${INSTALL_RELEASE}. Run quibtbot update before continuing.`,
    };
  }

  return { ok: true, state };
}

export function classifyInstallStateForUpdate(
  raw: unknown,
): { ok: true; state: InstallState } | { ok: false; reason: "corrupt"; message: string } {
  return inspectInstallStateStructure(raw);
}

export function classifyInstallStateReadOnly(raw: unknown): InstallStateValidation {
  return classifyInstallStateForInstall(raw);
}

export function classifyInstallState(raw: unknown): InstallStateValidation {
  return classifyInstallStateForInstall(raw);
}

export function validateInstallState(raw: unknown): InstallState | null {
  const classified = classifyInstallStateForInstall(raw);
  return classified.ok ? classified.state : null;
}

export function isInstallStateComplete(state: InstallState): boolean {
  return state.completed.length === INSTALL_STEPS.length;
}
