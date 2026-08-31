import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BOX_PUBLIC_PROXY_ENV } from "@quibt/core";
import { describe, expect, it } from "vitest";
import { INSTALL_RELEASE } from "./compose.js";
import { ensureInstallEnvironment, parseEnvFile } from "./environment.js";

const SECRET_KEYS = [
  "BETTER_AUTH_SECRET",
  "ENCRYPTION_KEY",
  "SANDBOX_SUPERVISOR_TOKEN",
  "BOOTSTRAP_SECRET",
  "DATABASE_PASSWORD",
] as const;

describe("ensureInstallEnvironment", () => {
  it("preserves generated secrets across repeated calls", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-install-env-"));
    const publicUrl = "http://127.0.0.1:5173";

    const first = ensureInstallEnvironment(dataDir, publicUrl);
    const second = ensureInstallEnvironment(dataDir, publicUrl);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.path).toBe(second.path);

    for (const key of SECRET_KEYS) {
      expect(second.values[key]).toBe(first.values[key]);
      expect(first.values[key]).toMatch(/^[0-9a-f]{64}$/);
    }

    expect(path.isAbsolute(first.values.DATA_DIR ?? "")).toBe(true);
    expect(statSync(first.path).mode & 0o777).toBe(0o600);

    const body = readFileSync(first.path, "utf8");
    for (const key of SECRET_KEYS) {
      expect(body).toContain(`${key}=${first.values[key]}`);
    }
  });

  it("writes stack version and host env file path for compose interpolation", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-install-env-"));
    const publicUrl = "http://127.0.0.1:5173";

    const first = ensureInstallEnvironment(dataDir, publicUrl);
    const second = ensureInstallEnvironment(dataDir, publicUrl);

    expect(first.values.QUIBT_STACK_VERSION).toBe(INSTALL_RELEASE);
    expect(first.values.QUIBT_WEB_BIND_HOST).toBe("127.0.0.1");
    expect(second.values.QUIBT_STACK_VERSION).toBe(INSTALL_RELEASE);
    expect(first.values.SIGNUPS_ENABLED).toBe("false");
    expect(first.values.INSTALL_ENV_FILE).toBe(first.path);
    expect(second.values.INSTALL_ENV_FILE).toBe(first.path);
  });

  it("expõe a interface web numa instalação VPS", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-install-env-"));
    const result = ensureInstallEnvironment(dataDir, "https://quibt.example.com");

    expect(result.values.QUIBT_WEB_BIND_HOST).toBe("0.0.0.0");
  });

  it("does not rewrite the env file when nothing changed", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-install-env-"));
    const publicUrl = "http://127.0.0.1:5173";

    ensureInstallEnvironment(dataDir, publicUrl);
    const before = statSync(path.join(dataDir, "quibt.env"));
    ensureInstallEnvironment(dataDir, publicUrl);
    const after = statSync(path.join(dataDir, "quibt.env"));

    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
  });

  it("preserves values that contain equals signs", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-install-env-"));
    const envPath = path.join(dataDir, "quibt.env");
    writeFileSync(
      envPath,
      [
        "CUSTOM=value=with=equals",
        "DATABASE_URL=postgres://quibt:secret=part@postgres:5432/quibt",
        "QUIBT_STACK_VERSION=0.1.0",
      ].join("\n"),
      { mode: 0o600 },
    );

    const result = ensureInstallEnvironment(dataDir, "http://127.0.0.1:5173");

    expect(result.values.CUSTOM).toBe("value=with=equals");
    expect(result.values.DATABASE_URL).toBe("postgres://quibt:secret=part@postgres:5432/quibt");
    expect(result.values.QUIBT_STACK_VERSION).toBe("0.1.0");
  });

  it("parses values containing equals signs", () => {
    expect(parseEnvFile("CUSTOM=value=with=equals\nKEY=part=ial")).toEqual({
      CUSTOM: "value=with=equals",
      KEY: "part=ial",
    });
  });

  it("preserves a Box proxy origin and reconciles auth plus bind addresses", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-install-env-"));
    const publicUrl = "https://quibt-owner-5173.on.ascii.dev";
    writeFileSync(
      path.join(dataDir, "quibt.env"),
      [
        `${BOX_PUBLIC_PROXY_ENV}=${publicUrl}`,
        "QUIBT_PUBLIC_HOST=stale.example.com",
        "QUIBT_WEB_BIND_HOST=127.0.0.1",
        "QUIBT_API_BIND_HOST=0.0.0.0",
        "WEB_ORIGIN=http://127.0.0.1:5173",
        "BETTER_AUTH_URL=http://127.0.0.1:5173",
        "API_URL=http://127.0.0.1:3100",
      ].join("\n"),
      { mode: 0o600 },
    );

    const result = ensureInstallEnvironment(dataDir, "http://127.0.0.1:5173");

    expect(result.values[BOX_PUBLIC_PROXY_ENV]).toBe(publicUrl);
    expect(result.values.QUIBT_PUBLIC_HOST).toBeUndefined();
    expect(result.values.QUIBT_WEB_BIND_HOST).toBe("0.0.0.0");
    expect(result.values.QUIBT_API_BIND_HOST).toBe("127.0.0.1");
    expect(result.values.WEB_ORIGIN).toBe(publicUrl);
    expect(result.values.BETTER_AUTH_URL).toBe(publicUrl);
    expect(result.values.API_URL).toBe(publicUrl);
  });
});
