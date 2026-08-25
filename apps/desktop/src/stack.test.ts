import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { composeInvocation } from "@quibt/installer";
import { describe, expect, it } from "vitest";
import {
  detectDocker,
  ensureDesktopEnv,
  findComposeFile,
  isBuildableCompose,
  isLocalWebUrl,
  localApiReadyUrl,
  packagedComposeFile,
  randomSecret,
  resolveStack,
  sourceComposeArgs,
} from "./stack.js";

describe("desktop stack helpers", () => {
  it("writes secrets once", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "quibt-desktop-"));
    const first = ensureDesktopEnv(dir);
    const second = ensureDesktopEnv(dir);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    const body = readFileSync(first.path, "utf8");
    expect(body).toContain("QUIBT_EDITION=oss");
    expect(body).toContain("AUTH_EMAIL_DISABLED=true");
    expect(body).toContain("QUIBT_WEB_BIND_HOST=127.0.0.1");
    expect(body).toContain("BETTER_AUTH_SECRET=");
  });

  it("builds source compose args against the env file", () => {
    expect(sourceComposeArgs("/tmp/compose.yml", "/tmp/quibt.env")).toEqual([
      "compose",
      "-f",
      "/tmp/compose.yml",
      "--env-file",
      "/tmp/quibt.env",
      "up",
      "-d",
      "--build",
    ]);
  });

  it("reports a missing docker binary", async () => {
    const result = await detectDocker(async () => {
      throw new Error("ENOENT");
    });
    expect(result.ok).toBe(false);
    expect(randomSecret()).toHaveLength(64);
  });

  it("prefers a compose file that can actually build the monorepo", () => {
    const root = mkdtempSync(path.join(tmpdir(), "quibt-compose-"));
    const composeDir = path.join(root, "infra", "compose");
    mkdirSync(composeDir, { recursive: true });
    writeFileSync(path.join(root, "package.json"), "{}");
    writeFileSync(path.join(composeDir, "Dockerfile"), "FROM scratch");
    writeFileSync(path.join(composeDir, "docker-compose.yml"), "services: {}");
    expect(isBuildableCompose(path.join(composeDir, "docker-compose.yml"))).toBe(true);
    expect(
      findComposeFile({
        userData: root,
        appPath: root,
        resourcesPath: path.join(root, "missing"),
      }),
    ).toBe(path.join(composeDir, "docker-compose.yml"));
  });

  it("probes the local API /ready next to the web origin", () => {
    expect(localApiReadyUrl("http://127.0.0.1:5173")).toBe("http://127.0.0.1:3100/ready");
    expect(localApiReadyUrl("https://app.example.com")).toBeNull();
    expect(isLocalWebUrl("http://127.0.0.1:5173")).toBe(true);
    expect(isLocalWebUrl("https://app.example.com")).toBe(false);
  });

  it("resolves bundled desktop compose to packaged-images", () => {
    const root = mkdtempSync(path.join(tmpdir(), "quibt-packaged-"));
    const resourcesPath = path.join(root, "resources");
    const composeDir = path.join(resourcesPath, "compose");
    mkdirSync(composeDir, { recursive: true });
    const bundledCompose = path.join(composeDir, "docker-compose.desktop.yml");
    writeFileSync(bundledCompose, "services: {}");
    const userData = path.join(root, "userData");
    mkdirSync(userData);

    expect(packagedComposeFile(resourcesPath)).toBe(bundledCompose);
    const resolution = resolveStack({
      userData,
      appPath: path.join(root, "app"),
      resourcesPath,
      isPackaged: true,
      webUrl: "http://127.0.0.1:5173",
    });
    expect(resolution.mode).toBe("packaged-images");
    expect(resolution.composeFile).toBe(bundledCompose);
    expect(resolution.dataDir).toBe(userData);
  });

  it("uses pull and up --wait without build for packaged compose", () => {
    const root = mkdtempSync(path.join(tmpdir(), "quibt-packaged-args-"));
    const userData = path.join(root, "userData");
    const composeFile = path.join(root, "compose", "docker-compose.desktop.yml");
    mkdirSync(path.dirname(composeFile), { recursive: true });
    writeFileSync(composeFile, "services: {}");
    const env = ensureDesktopEnv(userData);

    expect(env.path.startsWith(userData)).toBe(true);
    const pullArgs = composeInvocation("packaged", composeFile, env.path, "pull");
    const upArgs = composeInvocation("packaged", composeFile, env.path, "up");
    expect(pullArgs).toContain("pull");
    expect(upArgs).toContain("up");
    expect(upArgs).toContain("--wait");
    expect(pullArgs).not.toContain("--build");
    expect(upArgs).not.toContain("--build");
  });

  it("resolves remote when the web url is not local", () => {
    const root = mkdtempSync(path.join(tmpdir(), "quibt-remote-"));
    const userData = path.join(root, "userData");
    mkdirSync(userData);
    const resolution = resolveStack({
      userData,
      appPath: root,
      webUrl: "https://app.example.com",
    });
    expect(resolution.mode).toBe("remote");
    expect(resolution.composeFile).toBeNull();
    expect(resolution.dataDir).toBe(userData);
  });

  it("honors QUIBT_COMPOSE_FILE when the path exists", () => {
    const root = mkdtempSync(path.join(tmpdir(), "quibt-compose-env-"));
    const userData = path.join(root, "userData");
    const composeFile = path.join(root, "custom-compose.yml");
    mkdirSync(userData);
    writeFileSync(composeFile, "services: {}\n");
    const resolution = resolveStack({
      userData,
      appPath: root,
      composeFileOverride: composeFile,
      webUrl: "http://127.0.0.1:5173",
    });
    expect(resolution.composeFile).toBe(composeFile);
    expect(resolution.mode).toBe("packaged-images");
  });

  it("reports a missing QUIBT_COMPOSE_FILE override", () => {
    const root = mkdtempSync(path.join(tmpdir(), "quibt-compose-missing-"));
    const userData = path.join(root, "userData");
    mkdirSync(userData);
    const resolution = resolveStack({
      userData,
      appPath: root,
      composeFileOverride: path.join(root, "missing.yml"),
      webUrl: "http://127.0.0.1:5173",
    });
    expect(resolution.composeFile).toBeNull();
    expect(resolution.error).toMatch(/QUIBT_COMPOSE_FILE/);
  });

  it("resolves source-build from a checkout compose file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "quibt-source-"));
    const composeDir = path.join(root, "infra", "compose");
    mkdirSync(composeDir, { recursive: true });
    writeFileSync(path.join(root, "package.json"), "{}");
    writeFileSync(path.join(composeDir, "Dockerfile"), "FROM scratch");
    const composeFile = path.join(composeDir, "docker-compose.yml");
    writeFileSync(composeFile, "services: {}");
    const userData = path.join(root, "userData");
    mkdirSync(userData);

    const resolution = resolveStack({
      userData,
      appPath: root,
      isPackaged: false,
      webUrl: "http://127.0.0.1:5173",
    });
    expect(resolution.mode).toBe("source-build");
    expect(resolution.composeFile).toBe(composeFile);
    expect(resolution.dataDir).toBe(userData);
  });
});
