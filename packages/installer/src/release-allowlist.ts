import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { INSTALL_RELEASE } from "./compose.js";
import { parseEnvFile } from "./environment.js";
import { parseStrictSemver } from "./semver.js";
import { loadInstallStateForUpdate } from "./state-persist.js";

const EMBEDDED_ALLOWLIST = [INSTALL_RELEASE] as const;

export function embeddedRelease(): string {
  return INSTALL_RELEASE;
}

export function resolveUpdateTarget(
  requested?: string,
): { ok: true; release: string } | { ok: false; message: string } {
  const target = requested ?? INSTALL_RELEASE;
  const parsed = parseStrictSemver(target);
  if (!parsed) {
    return { ok: false, message: "Release must be a strict semver without newlines." };
  }
  if (!EMBEDDED_ALLOWLIST.includes(parsed as (typeof EMBEDDED_ALLOWLIST)[number])) {
    return {
      ok: false,
      message: `Release ${parsed} is not supported by the verified installer manifest.`,
    };
  }
  if (requested && requested !== INSTALL_RELEASE) {
    return {
      ok: false,
      message: "External release requires a verified manifest that includes that version.",
    };
  }
  return { ok: true, release: parsed };
}

function envFilePath(dataDir: string): string {
  return path.join(path.resolve(dataDir), "quibt.env");
}

export function resolvePreviousRelease(
  dataDir: string,
): { ok: true; release: string } | { ok: false; message: string } {
  const state = loadInstallStateForUpdate(dataDir);
  if (!state) {
    return {
      ok: false,
      message: "Install state is missing or invalid; cannot determine previous release.",
    };
  }

  const envFile = envFilePath(dataDir);
  if (!existsSync(envFile)) {
    return { ok: false, message: "Install environment file is missing." };
  }

  const envValues = parseEnvFile(readFileSync(envFile, "utf8"));
  const envRelease = envValues.QUIBT_STACK_VERSION;
  if (!envRelease || !parseStrictSemver(envRelease)) {
    return { ok: false, message: "Install environment has an invalid QUIBT_STACK_VERSION." };
  }

  if (envRelease !== state.release) {
    return {
      ok: false,
      message: `Install state release (${state.release}) does not match environment (${envRelease}).`,
    };
  }

  return { ok: true, release: state.release };
}
