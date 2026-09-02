import { Buffer } from "node:buffer";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PG_CUSTOM_DUMP_MAGIC } from "./backup.js";
import { ensureInstallEnvironment } from "./environment.js";
import { readInstallLock } from "./install-lock.js";
import type { InstallerEvent, ProcessRunner } from "./orchestrator.js";
import { initialInstallState, saveInstallState } from "./state-persist.js";
import { runUpdate } from "./update.js";

const COMPOSE_FILE = path.resolve("infra/compose/docker-compose.desktop.yml");

function validCustomDump(): Buffer {
  return Buffer.concat([PG_CUSTOM_DUMP_MAGIC, Buffer.alloc(128, 0)]);
}

function seedInstalledState(dataDir: string): void {
  const env = ensureInstallEnvironment(dataDir, "http://127.0.0.1:5173");
  saveInstallState(dataDir, {
    ...initialInstallState(undefined, new Date("2026-08-17T00:00:00.000Z")),
    completed: [
      "requirements",
      "environment",
      "images",
      "services",
      "database",
      "health",
      "pairing",
    ],
  });
  // Simula os arquivos que o instalador 0.2.13 gravou. O binário atual só cria/salva
  // estado da release embutida, mas o caminho de update precisa continuar aceitando um
  // estado antigo estruturalmente válido para poder migrá-lo.
  const statePath = path.join(dataDir, "install-state.json");
  writeFileSync(
    statePath,
    readFileSync(statePath, "utf8").replace('"release": "0.2.20"', '"release": "0.2.13"'),
    { mode: 0o600 },
  );
  writeFileSync(
    env.path,
    readFileSync(env.path, "utf8").replace(
      "QUIBT_STACK_VERSION=0.2.20",
      "QUIBT_STACK_VERSION=0.2.13",
    ),
    { mode: 0o600 },
  );
}

function imageInspectResponse(reference: string): string {
  if (reference.includes("quibt-stack")) return "sha256:stack-old";
  if (reference.includes("quibt-supervisor")) return "sha256:supervisor-old";
  if (reference.includes("quibt-computer")) return "sha256:computer-old";
  return "sha256:unknown";
}

function makeRunner(
  mode: "success" | "up-fail" | "migrate-fail" | "health-fail" | "bad-backup",
): ProcessRunner {
  let upAttempts = 0;
  const dump = validCustomDump();
  return {
    async run(command, args) {
      const joined = [command, ...args].join(" ");
      if (joined.includes("pg_dump")) {
        // `pg_dump -f -` creates a file literally named `-` in the container on the
        // supported Postgres image. Omitting `-f` is what streams the custom dump.
        if (args.slice(args.indexOf("pg_dump") + 1).includes("-f")) {
          return { code: 0, stdout: "", stderr: "", stdoutBytes: Buffer.alloc(0) };
        }
        if (mode === "bad-backup") {
          return { code: 0, stdout: "not-a-dump", stderr: "" };
        }
        return {
          code: 0,
          stdout: dump.toString("latin1"),
          stderr: "",
          stdoutBytes: dump,
        };
      }
      if (joined.includes(" compose") && joined.includes(" cp ")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (joined.includes("pg_restore")) {
        return { code: 0, stdout: "RESTORE", stderr: "" };
      }
      if (joined.includes("image inspect")) {
        const reference = args.at(-1) ?? "";
        return { code: 0, stdout: `${imageInspectResponse(reference)}\n`, stderr: "" };
      }
      if (joined.includes("docker tag")) return { code: 0, stdout: "", stderr: "" };
      if (joined.includes(" pull")) return { code: 0, stdout: "", stderr: "" };
      if (joined.includes(" up")) {
        upAttempts += 1;
        if (mode === "up-fail" && upAttempts === 1) {
          return { code: 1, stdout: "", stderr: "up failed" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      if (joined.includes("quibt-migrate") && mode === "migrate-fail") {
        return { code: 1, stdout: "", stderr: "pnpm: not found" };
      }
      if (joined.includes("quibt-migrate")) return { code: 0, stdout: "ok", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

describe("runUpdate", () => {
  it("creates verified backup, retains local image ids, and only changes env after backup", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-update-"));
    seedInstalledState(dataDir);
    const envBefore = readFileSync(path.join(dataDir, "quibt.env"), "utf8");

    const result = await runUpdate({
      dataDir,
      composeFile: COMPOSE_FILE,
      // A suíte não pode depender do disco livre de quem a roda.
      statfs: async () => ({ bsize: 4096, bavail: 25_000_000 }),
      targetRelease: "0.2.20",
      run: makeRunner("success"),
      fetch: async (url) => {
        if (String(url).endsWith("/ready")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response("down", { status: 503 });
      },
      clock: { now: () => new Date("2026-08-17T01:00:00.000Z"), sleep: async () => undefined },
    });

    expect(result.ok).toBe(true);
    expect(result.backupPath).toBeTruthy();
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(statSync(path.join(result.backupPath!, "dump.pgdump")).mode & 0o777).toBe(0o600);

    const rollback = JSON.parse(
      readFileSync(path.join(dataDir, "rollback-images.json"), "utf8"),
    ) as { release: string; images: Array<{ reference: string; id: string }> };
    expect(rollback.release).toBe("0.2.13");
    expect(rollback.images).toEqual([
      { reference: "ghcr.io/quibt/quibt-stack:0.2.13", id: "sha256:stack-old" },
      { reference: "ghcr.io/quibt/quibt-supervisor:0.2.13", id: "sha256:supervisor-old" },
      { reference: "ghcr.io/quibt/quibt-computer:0.2.13", id: "sha256:computer-old" },
    ]);
    expect(envBefore).toContain("QUIBT_STACK_VERSION=0.2.13");
    expect(readFileSync(path.join(dataDir, "quibt.env"), "utf8")).toContain(
      "QUIBT_STACK_VERSION=0.2.20",
    );
  });

  it("fails when backup verification does not match a pgcustom dump", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-update-fail-"));
    seedInstalledState(dataDir);

    const result = await runUpdate({
      dataDir,
      composeFile: COMPOSE_FILE,
      // A suíte não pode depender do disco livre de quem a roda.
      statfs: async () => ({ bsize: 4096, bavail: 25_000_000 }),
      run: makeRunner("bad-backup"),
      fetch: async () => new Response("down", { status: 503 }),
      clock: { now: () => new Date(), sleep: async () => undefined },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/backup verification failed/i);
    expect(readInstallLock(dataDir)).toBeNull();
  });

  it("rolls back env and images when service restart fails", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-update-rollback-"));
    seedInstalledState(dataDir);
    const envBefore = readFileSync(path.join(dataDir, "quibt.env"), "utf8");

    const result = await runUpdate({
      dataDir,
      composeFile: COMPOSE_FILE,
      // A suíte não pode depender do disco livre de quem a roda.
      statfs: async () => ({ bsize: 4096, bavail: 25_000_000 }),
      targetRelease: "0.2.20",
      run: makeRunner("up-fail"),
      fetch: async (url) => {
        if (String(url).endsWith("/ready")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response("down", { status: 503 });
      },
      clock: { now: () => new Date("2026-08-17T01:00:00.000Z"), sleep: async () => undefined },
    });

    expect(result.ok).toBe(false);
    expect(result.recovery?.status).toBe("completed");
    expect(readFileSync(path.join(dataDir, "quibt.env"), "utf8")).toBe(envBefore);
    expect(readInstallLock(dataDir)).toBeNull();
  });

  it("rolls back when migration fails", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-update-migrate-"));
    seedInstalledState(dataDir);
    const envBefore = readFileSync(path.join(dataDir, "quibt.env"), "utf8");

    const result = await runUpdate({
      dataDir,
      composeFile: COMPOSE_FILE,
      // A suíte não pode depender do disco livre de quem a roda.
      statfs: async () => ({ bsize: 4096, bavail: 25_000_000 }),
      targetRelease: "0.2.20",
      run: makeRunner("migrate-fail"),
      fetch: async (url) => {
        if (String(url).endsWith("/ready")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response("down", { status: 503 });
      },
      clock: { now: () => new Date("2026-08-17T01:00:00.000Z"), sleep: async () => undefined },
    });

    expect(result.ok).toBe(false);
    expect(result.recovery?.status).toBe("completed");
    expect(readFileSync(path.join(dataDir, "quibt.env"), "utf8")).toBe(envBefore);
    expect(result.error).toMatch(/quibt-migrate is missing/i);
  });

  it("baixa as imagens do jeito do install: progresso, paciência e três tentativas", async () => {
    // O install manda quem tem versão antiga rodar `quibtbot update`; lá o download não
    // pode ser o `compose pull` mudo de cinco minutos que a instalação já não usa.
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-update-pull-"));
    seedInstalledState(dataDir);
    const dump = validCustomDump();
    const targetImages = [
      "postgres:16@sha256:e17e86066e5ef83e0952a9347f5c792b7ece00972e2aa787a6986f471b3dd3d5",
      "ghcr.io/quibt/quibt-stack:0.2.20",
    ];
    const pulled: string[] = [];
    const pullOptions: Array<{ inactivityTimeoutMs?: number; timeoutMs?: number }> = [];
    let composePulls = 0;
    let stackAttempts = 0;
    const run: ProcessRunner = {
      async run(command, args, options) {
        const joined = [command, ...args].join(" ");
        if (joined.includes("pg_dump")) {
          return { code: 0, stdout: dump.toString("latin1"), stderr: "", stdoutBytes: dump };
        }
        if (joined.includes("image inspect")) {
          const reference = args.at(-1) ?? "";
          // Só a release instalada está no disco; a nova ainda não.
          return reference.endsWith(":0.2.13")
            ? { code: 0, stdout: `${imageInspectResponse(reference)}\n`, stderr: "" }
            : { code: 1, stdout: "", stderr: "Error: No such image" };
        }
        if (command === "docker" && args[0] === "info") {
          return { code: 0, stdout: "/var/lib/docker\n", stderr: "" };
        }
        if (joined.includes(" config --images")) {
          return { code: 0, stdout: `${targetImages.join("\n")}\n`, stderr: "" };
        }
        if (command === "docker" && args[0] === "pull") {
          const reference = args[1] as string;
          pullOptions.push(options ?? {});
          if (reference.includes("quibt-stack")) {
            stackAttempts += 1;
            if (stackAttempts === 1) {
              return { code: 1, stdout: "", stderr: "dial tcp: i/o timeout" };
            }
          }
          pulled.push(reference);
          options?.onOutput?.("aaaaaaaaaaaa: Pulling fs layer", "stdout");
          options?.onOutput?.("aaaaaaaaaaaa: Pull complete", "stdout");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (joined.includes(" compose") && joined.includes(" pull")) composePulls += 1;
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const events: InstallerEvent[] = [];
    const result = await runUpdate({
      dataDir,
      composeFile: COMPOSE_FILE,
      statfs: async () => ({ bsize: 4096, bavail: 25_000_000 }),
      targetRelease: "0.2.20",
      run,
      fetch: async (url) =>
        String(url).endsWith("/ready")
          ? new Response(JSON.stringify({ ok: true }), { status: 200 })
          : new Response("down", { status: 503 }),
      clock: { now: () => new Date("2026-08-17T01:00:00.000Z"), sleep: async () => undefined },
      onEvent: (event) => events.push(event),
    });

    expect(result.ok).toBe(true);
    expect(pulled).toEqual(targetImages);
    expect(composePulls).toBe(0);
    expect(stackAttempts).toBe(2);
    for (const options of pullOptions) {
      expect(options.inactivityTimeoutMs).toBe(900_000);
      expect(options.timeoutMs).toBe(60 * 60_000);
    }
    const images = events.filter((event) => event.step === "images");
    expect(images.some((event) => event.progress?.label === "quibt-stack:0.2.20")).toBe(true);
    expect(images.map((event) => event.message)).toContainEqual(
      expect.stringContaining("Vou baixar cerca de 1,7 GB"),
    );
    expect(images.map((event) => event.message)).toContainEqual(
      expect.stringContaining("Tentando de novo em 5 s"),
    );
  });

  it("reports manual recovery when rollback health fails", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-update-health-"));
    seedInstalledState(dataDir);

    const result = await runUpdate({
      dataDir,
      composeFile: COMPOSE_FILE,
      // A suíte não pode depender do disco livre de quem a roda.
      statfs: async () => ({ bsize: 4096, bavail: 25_000_000 }),
      targetRelease: "0.2.20",
      run: makeRunner("health-fail"),
      fetch: async () => new Response("down", { status: 503 }),
      clock: { now: () => new Date("2026-08-17T01:00:00.000Z"), sleep: async () => undefined },
    });

    expect(result.ok).toBe(false);
    expect(result.recovery?.status).toBe("manual_recovery_required");
    expect(result.recovery?.failedStep).toBe("health-ready");
  });
});
