import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { processExists } from "./process-exists.js";

export interface InstallLockRecord {
  pid: number;
  startedAt: string;
}

export const RECENT_INVALID_LOCK_MS = 30_000;

export function installLockPath(dataDir: string): string {
  return path.join(path.resolve(dataDir), "install.lock");
}

function lockMetaPath(dataDir: string): string {
  return path.join(installLockPath(dataDir), "meta.json");
}

function quarantineLockPath(dataDir: string, stamp: string): string {
  return path.join(path.resolve(dataDir), `install.lock.quarantined.${stamp}`);
}

function lockStamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export function readInstallLock(dataDir: string): InstallLockRecord | null {
  const metaPath = lockMetaPath(dataDir);
  if (!existsSync(metaPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as InstallLockRecord;
    if (!parsed.pid || !parsed.startedAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeLockMetaAtomic(dataDir: string, record: InstallLockRecord): void {
  const lockDir = installLockPath(dataDir);
  const metaPath = lockMetaPath(dataDir);
  const temp = path.join(lockDir, `meta.json.${record.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temp, metaPath);
}

function quarantineLockDir(dataDir: string, now = new Date()): boolean {
  const lockDir = installLockPath(dataDir);
  if (!existsSync(lockDir)) return false;
  const target = quarantineLockPath(dataDir, lockStamp(now));
  try {
    renameSync(lockDir, target);
    return true;
  } catch {
    return false;
  }
}

function lockMetaAgeMs(dataDir: string, nowMs: number): number | null {
  const metaPath = lockMetaPath(dataDir);
  if (!existsSync(metaPath)) return null;
  try {
    return nowMs - statSync(metaPath).mtimeMs;
  } catch {
    return null;
  }
}

function lockDirAgeMs(dataDir: string, nowMs: number): number | null {
  const lockDir = installLockPath(dataDir);
  if (!existsSync(lockDir)) return null;
  try {
    return nowMs - statSync(lockDir).mtimeMs;
  } catch {
    return null;
  }
}

function tryAcquireFreshLock(
  dataDir: string,
  pid: number,
  now: Date,
): { ok: true } | { ok: false; message: string } {
  const lockDir = installLockPath(dataDir);
  try {
    mkdirSync(lockDir, { mode: 0o700 });
    writeLockMetaAtomic(dataDir, { pid, startedAt: now.toISOString() });
    return { ok: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return { ok: false, message: "install lock already exists" };
    }
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // best effort cleanup after partial acquire
    }
    return { ok: false, message: "Could not acquire install lock." };
  }
}

export function acquireInstallLock(
  dataDir: string,
  pid = process.pid,
  now = new Date(),
  alive: (lockPid: number) => boolean = processExists,
  nowMs = Date.now(),
): { ok: true } | { ok: false; message: string } {
  mkdirSync(path.resolve(dataDir), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fresh = tryAcquireFreshLock(dataDir, pid, now);
    if (fresh.ok) return fresh;

    const lockDir = installLockPath(dataDir);
    if (!existsSync(lockDir)) continue;

    const existing = readInstallLock(dataDir);
    if (existing) {
      if (existing.pid !== pid && alive(existing.pid)) {
        return {
          ok: false,
          message: `Another install or update is already running (pid ${existing.pid}).`,
        };
      }
      if (quarantineLockDir(dataDir, now)) continue;
      return { ok: false, message: "Could not acquire install lock." };
    }

    const metaPath = lockMetaPath(dataDir);
    if (!existsSync(metaPath)) {
      const dirAgeMs = lockDirAgeMs(dataDir, nowMs);
      if (dirAgeMs !== null && dirAgeMs < RECENT_INVALID_LOCK_MS) {
        return {
          ok: false,
          message: "Another install or update is already running (lock directory is busy).",
        };
      }
      if (quarantineLockDir(dataDir, now)) continue;
      return { ok: false, message: "Could not acquire install lock." };
    }

    const metaAgeMs = lockMetaAgeMs(dataDir, nowMs);
    if (metaAgeMs !== null && metaAgeMs < RECENT_INVALID_LOCK_MS) {
      return {
        ok: false,
        message: "Another install or update is already running (lock metadata is busy).",
      };
    }

    if (quarantineLockDir(dataDir, now)) continue;
    return { ok: false, message: "Could not acquire install lock." };
  }

  return { ok: false, message: "Could not acquire install lock." };
}

export function releaseInstallLock(dataDir: string, pid = process.pid): void {
  const lockDir = installLockPath(dataDir);
  if (!existsSync(lockDir)) return;
  const current = readInstallLock(dataDir);
  if (current && current.pid !== pid) return;
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

export function touchLockMetaMtime(dataDir: string, mtimeMs: number): void {
  const metaPath = lockMetaPath(dataDir);
  writeFileSync(metaPath, readFileSync(metaPath, "utf8"), { mode: 0o600 });
  const mtime = new Date(mtimeMs);
  utimesSync(metaPath, mtime, mtime);
}

export function touchLockDirMtime(dataDir: string, mtimeMs: number): void {
  const lockDir = installLockPath(dataDir);
  const mtime = new Date(mtimeMs);
  utimesSync(lockDir, mtime, mtime);
}
