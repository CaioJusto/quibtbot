import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const composeFile = path.resolve("infra/compose/docker-compose.yml");
const backupScript = path.resolve("scripts/backup.sh");
const restoreScript = path.resolve("scripts/restore.sh");

function postgresUp() {
  try {
    execFileSync(
      "docker",
      [
        "compose",
        "-f",
        composeFile,
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "quibt",
        "-d",
        "quibt",
        "-Atqc",
        "select 1",
      ],
      { stdio: "ignore", timeout: 8_000 },
    );
    return true;
  } catch {
    return false;
  }
}

const describeBackup = postgresUp() ? describe : describe.skip;

describeBackup("compose backup and restore", () => {
  it("dumps postgres and restores into a side database", () => {
    expect(existsSync(backupScript)).toBe(true);
    expect(existsSync(restoreScript)).toBe(true);
    const stamp = `verify-${Date.now()}`;
    const restoreDatabase = `quibt_restore_${Date.now()}_${process.pid}`;
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "quibt-backup-fixture-"));
    mkdirSync(path.join(fixtureRoot, "data"));
    writeFileSync(path.join(fixtureRoot, "data", "probe.txt"), "backup probe\n");
    const dump = path.resolve("backups", stamp, "quibt.sql");
    const dockerCompose = ["compose", "-f", composeFile, "exec", "-T", "postgres"];
    const postgresSql = (sql: string, database = "postgres") =>
      execFileSync("docker", [...dockerCompose, "psql", "-U", "quibt", "-d", database, "-c", sql], {
        encoding: "utf8",
        timeout: 30_000,
      });
    try {
      execFileSync(backupScript, [stamp], {
        env: { ...process.env, QUIBT_BACKUP_ROOT: fixtureRoot },
        stdio: "pipe",
        timeout: 60_000,
      });
      expect(existsSync(dump)).toBe(true);
      const sql = readFileSync(dump, "utf8");
      expect(sql).toMatch(/CREATE TABLE|CREATE TABLE IF NOT EXISTS/i);
      expect(sql.toLowerCase()).toContain("bots");
      expect(sql).not.toMatch(/OPENROUTER_API_KEY|sk-or-v1-/);

      postgresSql(`DROP DATABASE IF EXISTS "${restoreDatabase}"`);
      postgresSql(`CREATE DATABASE "${restoreDatabase}"`);
      execFileSync("docker", [...dockerCompose, "psql", "-U", "quibt", "-d", restoreDatabase], {
        input: sql,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60_000,
      });
      const tables = postgresSql("\\dt", restoreDatabase);
      expect(tables).toMatch(/bots/);
    } finally {
      try {
        postgresSql(`DROP DATABASE IF EXISTS "${restoreDatabase}"`);
      } catch {
        // The assertion retains the primary failure; the unique side database is disposable.
      }
      rmSync(path.resolve("backups", stamp), { recursive: true, force: true });
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
