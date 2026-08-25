import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import path from "node:path";

export const PG_CUSTOM_DUMP_MAGIC = Buffer.from("PGDMP");

export interface BackupMetadata {
  path: string;
  checksum: string;
  createdAt: string;
  size: number;
  format: "pgcustom";
}

export interface BackupBundle {
  dir: string;
  dumpPath: string;
  metaPath: string;
  checksum: string;
  size: number;
  createdAt: string;
}

export function sha256HexBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function isValidPgCustomDump(buffer: Buffer): boolean {
  if (buffer.length < PG_CUSTOM_DUMP_MAGIC.length + 4) return false;
  return buffer.subarray(0, PG_CUSTOM_DUMP_MAGIC.length).equals(PG_CUSTOM_DUMP_MAGIC);
}

function ensureRestrictedDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function writeBufferWithFsync(target: string, body: Buffer, mode = 0o600): void {
  const fd = openSync(target, "w", mode);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(target, mode);
}

function writeTextWithFsync(target: string, body: string, mode = 0o600): void {
  const fd = openSync(target, "w", mode);
  try {
    writeSync(fd, body, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(target, mode);
}

function fsyncDir(targetDir: string): void {
  const fd = openSync(targetDir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeAtomicFile(target: string, body: string, mode = 0o600): void {
  const dir = path.dirname(target);
  ensureRestrictedDir(dir);
  const temp = `${target}.${process.pid}.tmp`;
  writeTextWithFsync(temp, body, mode);
  renameSync(temp, target);
  fsyncDir(dir);
}

export function writeBackupBundle(
  backupsDir: string,
  stamp: string,
  dumpContents: Buffer,
): BackupBundle {
  if (!isValidPgCustomDump(dumpContents)) {
    throw new Error("database backup verification failed");
  }

  ensureRestrictedDir(backupsDir);
  const tempDir = path.join(backupsDir, `.tmp-pre-update-${stamp}-${process.pid}`);
  const finalDir = path.join(backupsDir, `pre-update-${stamp}`);
  mkdirSync(tempDir, { recursive: true, mode: 0o700 });

  const finalDumpPath = path.join(finalDir, "dump.pgdump");
  const finalMetaPath = path.join(finalDir, "meta.json");
  const tempDumpPath = path.join(tempDir, "dump.pgdump");
  const tempMetaPath = path.join(tempDir, "meta.json");
  const checksum = sha256HexBuffer(dumpContents);
  const createdAt = new Date().toISOString();
  const size = dumpContents.length;

  writeBufferWithFsync(tempDumpPath, dumpContents, 0o600);
  writeTextWithFsync(
    tempMetaPath,
    `${JSON.stringify(
      {
        path: finalDumpPath,
        checksum,
        createdAt,
        size,
        format: "pgcustom",
      } satisfies BackupMetadata,
      null,
      2,
    )}\n`,
    0o600,
  );
  fsyncDir(tempDir);

  renameSync(tempDir, finalDir);
  chmodSync(finalDir, 0o700);
  fsyncDir(backupsDir);

  return {
    dir: finalDir,
    dumpPath: finalDumpPath,
    metaPath: finalMetaPath,
    checksum,
    size,
    createdAt,
  };
}

export function validateBackupBundle(bundle: BackupBundle): boolean {
  if (!existsSync(bundle.dumpPath) || !existsSync(bundle.metaPath)) return false;
  let meta: BackupMetadata;
  try {
    meta = JSON.parse(readFileSync(bundle.metaPath, "utf8")) as BackupMetadata;
  } catch {
    return false;
  }
  if (meta.path !== bundle.dumpPath) return false;
  if (meta.format !== "pgcustom") return false;
  const dump = readFileSync(bundle.dumpPath);
  if (dump.length !== meta.size) return false;
  if (sha256HexBuffer(dump) !== meta.checksum) return false;
  return isValidPgCustomDump(dump);
}

export function readBackupMetadata(metaPath: string): BackupMetadata | null {
  if (!existsSync(metaPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as BackupMetadata;
    if (!parsed.path || !parsed.checksum || parsed.format !== "pgcustom") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function decodeProcessStdoutBytes(stdout: string, stdoutBytes?: Buffer): Buffer {
  if (stdoutBytes && stdoutBytes.length > 0) return stdoutBytes;
  return Buffer.from(stdout, "latin1");
}

export function isValidPostgresDump(contents: string): boolean {
  return isValidPgCustomDump(Buffer.from(contents, "latin1"));
}
