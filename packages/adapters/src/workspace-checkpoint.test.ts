import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@quibt/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { BoxSandboxEmulator } from "./box-emulator.js";
import { DaytonaSandboxEmulator } from "./daytona-emulator.js";
import { ManagedSandboxEmulator } from "./e2b-emulator.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import {
  applyToFileMap,
  collectFromFileMap,
  createWorkspaceCheckpointStore,
  hostDirPortableHomeVolume,
  isSafePortablePath,
  portableHomeLayout,
  shouldExcludePortablePath,
  withWorkspaceCheckpoint,
} from "./workspace-checkpoint.js";

const ctx: AdapterContext = {
  operationId: "checkpoint",
  traceId: "checkpoint",
  workspaceId: "ws-checkpoint",
  userId: "user",
  signal: new AbortController().signal,
};

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function writeViaShell(
  provider: SandboxProvider,
  computer: ComputerRef,
  filePath: string,
  content: string,
) {
  for await (const event of provider.execute(
    computer,
    { argv: ["sh", "-c", `echo ${content} > ${filePath}`] },
    ctx,
  )) {
    if (event.type === "exit") expect(event.code).toBe(0);
  }
}

async function readViaShell(provider: SandboxProvider, computer: ComputerRef, filePath: string) {
  let stdout = "";
  for await (const event of provider.execute(computer, { argv: ["cat", filePath] }, ctx)) {
    if (event.type === "stdout") stdout += event.data;
  }
  return stdout;
}

describe("shouldExcludePortablePath", () => {
  it("drops Chromium caches, tmp, node_modules, npm cacache and trash", () => {
    expect(shouldExcludePortablePath("chrome/Cache/data_1")).toBe(true);
    expect(shouldExcludePortablePath("chrome/Code Cache/js/index")).toBe(true);
    expect(shouldExcludePortablePath("chrome/GPUCache/index")).toBe(true);
    expect(shouldExcludePortablePath("home/tmp/scratch")).toBe(true);
    expect(shouldExcludePortablePath("home/project/node_modules/leftpad/index.js")).toBe(true);
    expect(shouldExcludePortablePath("home/.npm/_cacache/index")).toBe(true);
    expect(shouldExcludePortablePath("home/.local/share/Trash/files/old")).toBe(true);
    expect(shouldExcludePortablePath("home/trash/old")).toBe(true);
  });

  it("keeps home files and Chromium profile cookies", () => {
    expect(shouldExcludePortablePath("home/notes.txt")).toBe(false);
    expect(shouldExcludePortablePath("chrome/Default/Cookies")).toBe(false);
    expect(shouldExcludePortablePath("chrome/Default/Preferences")).toBe(false);
  });

  it("drops live Chromium lock files so the next browser can start", () => {
    expect(shouldExcludePortablePath("chrome/SingletonLock")).toBe(true);
    expect(shouldExcludePortablePath("chrome/SingletonSocket")).toBe(true);
    expect(shouldExcludePortablePath("chrome/lockfile")).toBe(true);
  });
});

describe("isSafePortablePath", () => {
  it("rejects traversal and absolute tails", () => {
    expect(isSafePortablePath("home/../../etc/passwd")).toBe(false);
    expect(isSafePortablePath("chrome/../home/secret")).toBe(false);
    expect(isSafePortablePath("home//etc/passwd")).toBe(false);
    expect(isSafePortablePath("/etc/passwd")).toBe(false);
    expect(isSafePortablePath("etc/passwd")).toBe(false);
  });

  it("accepts home and chrome relatives", () => {
    expect(isSafePortablePath("home/notes.txt")).toBe(true);
    expect(isSafePortablePath("chrome/Default/Cookies")).toBe(true);
  });
});

describe("portableHomeLayout", () => {
  it("maps each provider family to its portable home and chrome roots", () => {
    expect(portableHomeLayout("docker", "bot-a").homeRoot).toBe("/home/quibt");
    expect(portableHomeLayout("docker", "bot-a").chromeRoots[0]).toBe(
      "/quibt-desktops/bot-a/chrome",
    );
    expect(portableHomeLayout("e2b", "bot-a").homeRoot).toBe("/home/user");
    expect(portableHomeLayout("e2b-emulator", "bot-a").homeRoot).toBe("/home/user");
    expect(portableHomeLayout("box", "bot-a").homeRoot).toBe("/home/ubuntu");
    expect(portableHomeLayout("daytona", "bot-a").homeRoot).toBe("/home/daytona");
    expect(portableHomeLayout("fake", "bot-a").homeRoot).toBe("/home/quibt");
    expect(portableHomeLayout("docker", "bot-a").sharedHome).toBe(true);
    expect(portableHomeLayout("remote-supervisor", "bot-a").sharedHome).toBe(true);
    expect(portableHomeLayout("e2b", "bot-a").sharedHome).toBe(false);
    expect(portableHomeLayout("fake", "bot-a").sharedHome).toBe(false);
  });
});

describe("shared Docker home apply", () => {
  it("restores chrome only and leaves a sibling file on the shared home", () => {
    const files = new Map<string, string>([["/home/quibt/sibling.txt", "from-b"]]);
    applyToFileMap(files, portableHomeLayout("docker", "bot-a"), [
      { path: "home/notes.txt", content: new TextEncoder().encode("from-a") },
      { path: "chrome/Cookies", content: new TextEncoder().encode("cookie-a") },
    ]);
    expect(files.get("/home/quibt/sibling.txt")).toBe("from-b");
    expect(files.get("/home/quibt/notes.txt")).toBeUndefined();
    expect(files.get("/quibt-desktops/bot-a/chrome/Cookies")).toBe("cookie-a");
  });

  it("still exports a copy of the shared home when leaving Docker", () => {
    const files = new Map<string, string>([
      ["/home/quibt/office.txt", "shared"],
      ["/quibt-desktops/bot-a/chrome/Cookies", "cookie-a"],
    ]);
    const entries = collectFromFileMap(files, portableHomeLayout("docker", "bot-a"));
    expect(entries.map((entry) => entry.path).sort()).toEqual([
      "chrome/Cookies",
      "home/office.txt",
    ]);
  });
});

describe("portable computer home across emulator providers", () => {
  it("restores a file and cookie from E2B onto Box after destroy, dropping Cache", async () => {
    const dataDir = await tempDir("quibt-checkpoint-");
    const store = createWorkspaceCheckpointStore({
      dataDir,
      encryptionKey: "test-encryption-key-32chars-minimum!!",
    });
    const source = withWorkspaceCheckpoint(new ManagedSandboxEmulator(), store);
    const target = withWorkspaceCheckpoint(new BoxSandboxEmulator(), store);

    const created = await source.provision({ botId: "bot-travel", homePath: "/tmp/a" }, ctx);
    const home = portableHomeLayout(created.kind, created.botId);
    const chrome = home.chromeRoots[0]!;
    await writeViaShell(source, created, `${home.homeRoot}/notes.txt`, "hello-from-e2b");
    await writeViaShell(source, created, `${chrome}/Default/Cookies`, "cookie-v1");
    await writeViaShell(source, created, `${chrome}/Cache/data_1`, "cache-junk");

    await source.destroy(created, ctx);

    const hydrated = await target.provision({ botId: "bot-travel", homePath: "/tmp/b" }, ctx);
    const dest = portableHomeLayout(hydrated.kind, hydrated.botId);
    const destChrome = dest.chromeRoots[0]!;

    expect(await readViaShell(target, hydrated, `${dest.homeRoot}/notes.txt`)).toContain(
      "hello-from-e2b",
    );
    expect(await readViaShell(target, hydrated, `${destChrome}/Default/Cookies`)).toContain(
      "cookie-v1",
    );
    expect(await readViaShell(target, hydrated, `${destChrome}/Cache/data_1`)).not.toContain(
      "cache-junk",
    );
    await target.destroy(hydrated, ctx);
  });

  it("also hydrates Daytona from a Docker-shaped fake after a stop", async () => {
    const dataDir = await tempDir("quibt-checkpoint-");
    const store = createWorkspaceCheckpointStore({
      dataDir,
      encryptionKey: "test-encryption-key-32chars-minimum!!",
    });
    const source = withWorkspaceCheckpoint(new FakeSandboxProvider({ scope: "bot" }), store);
    const target = withWorkspaceCheckpoint(new DaytonaSandboxEmulator(), store);

    const created = await source.provision({ botId: "bot-day", homePath: "/tmp/a" }, ctx);
    await writeViaShell(source, created, "/home/quibt/report.txt", "from-fake");
    await writeViaShell(source, created, "/quibt-desktops/bot-day/chrome/Cookies", "crumb");
    await source.stop(created, ctx);
    await source.destroy(created, ctx);

    const hydrated = await target.provision({ botId: "bot-day", homePath: "/tmp/b" }, ctx);
    expect(await readViaShell(target, hydrated, "/home/daytona/report.txt")).toContain("from-fake");
    expect(
      await readViaShell(target, hydrated, "/home/daytona/.config/chromium/Cookies"),
    ).toContain("crumb");
    await target.destroy(hydrated, ctx);
  });

  it("is a no-op when a brand-new bot has no snapshot", async () => {
    const dataDir = await tempDir("quibt-checkpoint-");
    const store = createWorkspaceCheckpointStore({
      dataDir,
      encryptionKey: "test-encryption-key-32chars-minimum!!",
    });
    const box = withWorkspaceCheckpoint(new BoxSandboxEmulator(), store);
    const computer = await box.provision({ botId: "brand-new", homePath: "/tmp/new" }, ctx);
    expect(await readViaShell(box, computer, "/home/ubuntu/notes.txt")).toBe("");
    await box.destroy(computer, ctx);
  });

  it("keeps two bots on separate snapshots", async () => {
    const dataDir = await tempDir("quibt-checkpoint-");
    const store = createWorkspaceCheckpointStore({
      dataDir,
      encryptionKey: "test-encryption-key-32chars-minimum!!",
    });
    const first = withWorkspaceCheckpoint(new ManagedSandboxEmulator(), store);
    const second = withWorkspaceCheckpoint(new BoxSandboxEmulator(), store);

    const a = await first.provision({ botId: "bot-a", homePath: "/tmp/a" }, ctx);
    await writeViaShell(first, a, "/home/user/secret-a.txt", "only-a");
    await first.destroy(a, ctx);

    const b = await second.provision({ botId: "bot-b", homePath: "/tmp/b" }, ctx);
    expect(await readViaShell(second, b, "/home/ubuntu/secret-a.txt")).not.toContain("only-a");
    await second.destroy(b, ctx);

    const aAgain = await second.provision({ botId: "bot-a", homePath: "/tmp/a2" }, ctx);
    expect(await readViaShell(second, aAgain, "/home/ubuntu/secret-a.txt")).toContain("only-a");
    await second.destroy(aAgain, ctx);
  });

  it("encrypts the snapshot so plaintext never sits on DATA_DIR", async () => {
    const dataDir = await tempDir("quibt-checkpoint-");
    const store = createWorkspaceCheckpointStore({
      dataDir,
      encryptionKey: "test-encryption-key-32chars-minimum!!",
    });
    const source = withWorkspaceCheckpoint(new FakeSandboxProvider({ scope: "bot" }), store);
    const computer = await source.provision({ botId: "bot-secret", homePath: "/tmp/s" }, ctx);
    await writeViaShell(source, computer, "/home/quibt/private.txt", "super-secret-token");
    await source.destroy(computer, ctx);

    const blob = await readFile(
      path.join(dataDir, "workspace-checkpoints", "bot-secret", "snapshot.qbhc"),
    );
    expect(blob.subarray(0, 5).toString("utf8")).toBe("QBHC1");
    expect(blob.toString("utf8")).not.toContain("super-secret-token");
  });
});

describe("hostDirPortableHomeVolume", () => {
  it("round-trips a host home and chrome profile through the store", async () => {
    const dataDir = await tempDir("quibt-hostvol-");
    const store = createWorkspaceCheckpointStore({
      dataDir,
      encryptionKey: "test-encryption-key-32chars-minimum!!",
    });
    const home = path.join(dataDir, "workspaces", "ws1", "home");
    const chrome = path.join(dataDir, "workspaces", "ws1", "desktops", "bot-1", "chrome");
    await mkdir(path.join(home, "docs"), { recursive: true });
    await mkdir(path.join(chrome, "Default"), { recursive: true });
    await mkdir(path.join(chrome, "Cache"), { recursive: true });
    await writeFile(path.join(home, "docs", "todo.txt"), "buy milk");
    await writeFile(path.join(chrome, "Default", "Cookies"), "host-cookie");
    await writeFile(path.join(chrome, "Cache", "x"), "drop-me");

    const volume = hostDirPortableHomeVolume({ homeRoot: home, chromeRoot: chrome });
    await store.save("bot-1", await volume.collect());

    await rm(home, { recursive: true, force: true });
    await rm(chrome, { recursive: true, force: true });

    const restored = hostDirPortableHomeVolume({ homeRoot: home, chromeRoot: chrome });
    const loaded = await store.load("bot-1");
    expect(loaded).not.toBeNull();
    await restored.apply(loaded!);

    expect(await readFile(path.join(home, "docs", "todo.txt"), "utf8")).toBe("buy milk");
    expect(await readFile(path.join(chrome, "Default", "Cookies"), "utf8")).toBe("host-cookie");
    await expect(readFile(path.join(chrome, "Cache", "x"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("round-trips an empty file", async () => {
    const dataDir = await tempDir("quibt-empty-");
    const store = createWorkspaceCheckpointStore({
      dataDir,
      encryptionKey: "test-encryption-key-32chars-minimum!!",
    });
    await store.save("bot-empty", [{ path: "home/empty.txt", content: new Uint8Array() }]);
    const loaded = await store.load("bot-empty");
    expect(loaded).toHaveLength(1);
    expect(loaded?.[0]?.path).toBe("home/empty.txt");
    expect(loaded?.[0]?.content.byteLength).toBe(0);
  });

  it("refuses a snapshot path that escapes home", async () => {
    const dataDir = await tempDir("quibt-escape-");
    const store = createWorkspaceCheckpointStore({
      dataDir,
      encryptionKey: "test-encryption-key-32chars-minimum!!",
    });
    await store.save("bot-escape", [
      { path: "home/../../etc/passwd", content: new TextEncoder().encode("nope") },
    ]);
    expect(await store.load("bot-escape")).toEqual([]);
  });
});
