import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const created: string[] = [];

/**
 * The scripts are copied into a throwaway root with a stub `docker` on PATH, so the real
 * behaviour (exit codes, files written, psql flags) is exercised without a live cluster.
 */
function sandbox() {
  const root = mkdtempSync(path.join(tmpdir(), "quibt-backup-"));
  created.push(root);
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "infra", "compose"), { recursive: true });
  mkdirSync(path.join(root, "data", "workspaces"), { recursive: true });
  mkdirSync(path.join(root, "bin"), { recursive: true });
  writeFileSync(path.join(root, "infra", "compose", "docker-compose.yml"), "services: {}\n");
  writeFileSync(path.join(root, "data", "workspaces", "note.txt"), "home\n");
  for (const script of ["backup.sh", "restore.sh"]) {
    copyFileSync(path.join(repoRoot, "scripts", script), path.join(root, "scripts", script));
    chmodSync(path.join(root, "scripts", script), 0o755);
  }
  const log = path.join(root, "docker.log");
  const stub = path.join(root, "bin", "docker");
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      'echo "$*" >> "$STUB_LOG"',
      'case "$*" in',
      "  *pg_dump*)",
      '    if [ "$STUB_FAIL_PGDUMP" = "1" ]; then echo "pg_dump: connection failed" >&2; exit 1; fi',
      '    echo "-- fake dump"',
      '    echo "CREATE TABLE bots ();"',
      "    ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
  return { root, log, stub };
}

function run(script: string, args: string[], env: NodeJS.ProcessEnv, root: string, log: string) {
  return execFileSync("bash", [path.join(root, "scripts", script), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
      STUB_LOG: log,
      ...env,
    },
  });
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("backup.sh", () => {
  it("writes the dump and the homes archive when postgres answers", () => {
    const { root, log } = sandbox();
    run("backup.sh", ["stamp"], {}, root, log);
    const out = path.join(root, "backups", "stamp");
    expect(readFileSync(path.join(out, "quibt.sql"), "utf8")).toContain("CREATE TABLE bots");
    expect(existsSync(path.join(out, "homes.tgz"))).toBe(true);
    expect(existsSync(path.join(out, "quibt.sql.partial"))).toBe(false);
    expect(readFileSync(log, "utf8")).toContain("pg_dump");
  });

  it("fails loudly and leaves no dump behind when pg_dump fails", () => {
    const { root, log } = sandbox();
    expect(() => run("backup.sh", ["stamp"], { STUB_FAIL_PGDUMP: "1" }, root, log)).toThrow();
    const out = path.join(root, "backups", "stamp");
    expect(existsSync(path.join(out, "quibt.sql"))).toBe(false);
    expect(existsSync(path.join(out, "quibt.sql.partial"))).toBe(false);
  });

  it("rejects a backup name that escapes the backups folder", () => {
    const { root, log } = sandbox();
    expect(() => run("backup.sh", ["../etc"], {}, root, log)).toThrow();
  });
});

describe("restore.sh", () => {
  function withBackup() {
    const box = sandbox();
    run("backup.sh", ["stamp"], {}, box.root, box.log);
    return { ...box, src: path.join(box.root, "backups", "stamp") };
  }

  it("refuses to overwrite the database without confirmation", () => {
    const { root, log, src } = withBackup();
    expect(() => run("restore.sh", [src], {}, root, log)).toThrow();
    expect(readFileSync(log, "utf8")).not.toContain("psql");
  });

  it("stops on the first SQL error when it is confirmed", () => {
    const { root, log, src } = withBackup();
    const output = run("restore.sh", [src, "--yes"], {}, root, log);
    const calls = readFileSync(log, "utf8");
    expect(output).toContain("Restore complete");
    expect(calls).toContain("psql -v ON_ERROR_STOP=1 --single-transaction");
    expect(calls).toContain("up -d postgres");
  });

  it("stops when the dump is missing instead of wiping the database", () => {
    const { root, log } = sandbox();
    expect(() =>
      run("restore.sh", [path.join(root, "backups", "gone"), "--yes"], {}, root, log),
    ).toThrow();
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").not.toContain("psql");
  });
});
