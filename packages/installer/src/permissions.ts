import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";

export function diagnoseDataDirectory(dataDir: string): { ok: boolean; message: string } {
  const resolved = path.resolve(dataDir);
  if (!existsSync(resolved)) {
    return { ok: false, message: `Install data directory does not exist: ${resolved}` };
  }

  try {
    const stats = statSync(resolved);
    if (!stats.isDirectory()) {
      return { ok: false, message: `Install data path is not a directory: ${resolved}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "stat failed";
    return { ok: false, message: `Install data directory is not accessible: ${message}` };
  }

  try {
    accessSync(resolved, constants.W_OK);
  } catch (error) {
    const message = error instanceof Error ? error.message : "not writable";
    return { ok: false, message: `Install data directory is not writable: ${message}` };
  }

  return { ok: true, message: "Install data directory exists and is writable" };
}

export function diagnoseEnvFilePermissions(envFile: string): { ok: boolean; message: string } {
  if (!existsSync(envFile)) {
    return { ok: false, message: "Environment file is missing" };
  }

  const mode = statSync(envFile).mode & 0o777;
  if (mode !== 0o600) {
    return {
      ok: false,
      message: `Environment file permissions are ${mode.toString(8)} (expected 0600)`,
    };
  }

  return { ok: true, message: "Environment file permissions are 0600" };
}
