import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import type { ComputerRef, SandboxProvider } from "@quibt/adapter-kit";
import { afterAll, describe, expect, it } from "vitest";
import { BoxSandboxEmulator } from "./box-emulator.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import { ManagedSandboxEmulator } from "./e2b-emulator.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";

const ctx = {
  operationId: "1",
  traceId: "1",
  workspaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

async function drain(provider: SandboxProvider, computer: ComputerRef) {
  let stdout = "";
  for await (const event of provider.execute(computer, { argv: ["echo", "graphical-ok"] }, ctx)) {
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "exit") expect(event.code).toBe(0);
  }
  return stdout;
}

describe("sandbox conformance", () => {
  it("runs the same graphical command on fake, managed-sandbox emulator, and desktop", async () => {
    const fake = new FakeSandboxProvider();
    const managed = new ManagedSandboxEmulator();
    const desktop = new DesktopSandboxProvider();
    const a = await fake.provision({ botId: "bot-a", homePath: "/tmp/a" }, ctx);
    const b = await managed.provision({ botId: "bot-b", homePath: "/tmp/b" }, ctx);
    const c = await desktop.provision({ botId: "bot-c", homePath: "/tmp/c" }, ctx);
    const outA = await drain(fake, a);
    const outB = await drain(managed, b);
    const outC = await drain(desktop, c);
    expect(outA).toContain("graphical-ok");
    expect(outB).toContain("graphical-ok");
    expect(outC).toContain("graphical-ok");
    expect([a.kind, b.kind, c.kind]).toEqual(["fake", "e2b", "desktop"]);
    await fake.destroy(a, ctx);
    await managed.destroy(b, ctx);
    await desktop.destroy(c, ctx);
  });

  it("desktop executor refuses paths outside granted folders", async () => {
    const desktop = new DesktopSandboxProvider({ grants: [] });
    const computer = await desktop.provision({ botId: "grant", homePath: "/tmp/grant" }, ctx);
    let stderr = "";
    let code = 0;
    for await (const event of desktop.execute(
      computer,
      { argv: ["echo", "nope"], cwd: "/etc" },
      ctx,
    )) {
      if (event.type === "stderr") stderr += event.data;
      if (event.type === "exit") code = event.code;
    }
    expect(code).toBe(1);
    expect(stderr).toMatch(/not granted/i);
    await desktop.destroy(computer, ctx);
  });

  it("desktop addGrant unlocks a previously refused path", async () => {
    const desktop = new DesktopSandboxProvider({ grants: [] });
    const computer = await desktop.provision(
      { botId: "grant-add", homePath: "/tmp/grant-add" },
      ctx,
    );
    desktop.addGrant(ctx.userId, "/etc");
    let code = 1;
    for await (const event of desktop.execute(
      computer,
      { argv: ["echo", "granted"], cwd: "/etc" },
      ctx,
    )) {
      if (event.type === "exit") code = event.code;
    }
    expect(code).toBe(0);
    await desktop.destroy(computer, ctx);
  });

  it("never executes arbitrary agent commands on the service host", async () => {
    const desktop = new DesktopSandboxProvider();
    const computer = await desktop.provision({ botId: "no-host-shell", homePath: "/tmp" }, ctx);
    let stderr = "";
    let code = 0;
    for await (const event of desktop.execute(computer, { argv: ["bash", "-lc", "env"] }, ctx)) {
      if (event.type === "stderr") stderr += event.data;
      if (event.type === "exit") code = event.code;
    }
    expect(code).toBe(126);
    expect(stderr).toMatch(/host command execution is disabled/i);
    await desktop.destroy(computer, ctx);
  });
});

describe("box sandbox per-bot isolation (emulator)", () => {
  it("gives each bot its own provider ref, isolated files, and independent stop state", async () => {
    const box = new BoxSandboxEmulator();
    const a = await box.provision({ botId: "bot-a", homePath: "/tmp/a" }, ctx);
    const b = await box.provision({ botId: "bot-b", homePath: "/tmp/b" }, ctx);
    expect(a.providerRef).not.toBe(b.providerRef);
    expect(a.providerRef).toBe(`fake-${ctx.workspaceId}-bot-a`);
    expect(b.providerRef).toBe(`fake-${ctx.workspaceId}-bot-b`);
    for await (const event of box.execute(
      a,
      { argv: ["sh", "-c", "echo isolated-a > /workspace/note.txt"] },
      ctx,
    )) {
      if (event.type === "exit") expect(event.code).toBe(0);
    }
    let stdout = "";
    for await (const event of box.execute(b, { argv: ["cat", "/workspace/note.txt"] }, ctx)) {
      if (event.type === "stdout") stdout += event.data;
    }
    expect(stdout).not.toContain("isolated-a");
    await box.stop(a, ctx);
    const boxA = [...box.dest.values()].find((entry) => entry.ref.botId === "bot-a");
    const boxB = [...box.dest.values()].find((entry) => entry.ref.botId === "bot-b");
    expect(boxA?.running).toBe(false);
    expect(boxB?.running).toBe(true);
    await box.destroy(a, ctx);
    await box.destroy(b, ctx);
  });
});

describe("box sandbox (emulator)", () => {
  it("runs the same graphical command and preserves state across stop/provision", async () => {
    const box = new BoxSandboxEmulator();
    const computer = await box.provision({ botId: "bot-box", homePath: "/tmp/box" }, ctx);
    expect(computer.kind).toBe("box");
    const out = await drain(box, computer);
    expect(out).toContain("graphical-ok");
    for await (const event of box.execute(
      computer,
      { argv: ["sh", "-c", "echo box-persist > /workspace/box.txt"] },
      ctx,
    )) {
      if (event.type === "exit") expect(event.code).toBe(0);
    }
    await box.stop(computer, ctx);
    const resumed = await box.provision(
      { botId: "bot-box", homePath: "/tmp/box", providerRef: computer.providerRef },
      ctx,
    );
    expect(resumed.providerRef).toBe(computer.providerRef);
    let stdout = "";
    for await (const event of box.execute(resumed, { argv: ["cat", "/workspace/box.txt"] }, ctx)) {
      if (event.type === "stdout") stdout += event.data;
    }
    expect(stdout).toContain("box-persist");
    const screen = await box.connectScreen(resumed, { view: "stream" }, ctx);
    expect(screen.url).toBeTruthy();
    const snap = await box.snapshot(resumed, ctx);
    expect(snap.id).toBeTruthy();
    await box.destroy(resumed, ctx);
  });
});

describe("shared workspace computer (fake)", () => {
  it("lets bot A write a file that bot B can read, with distinct screens and clipboards", async () => {
    const fake = new FakeSandboxProvider();
    const a = await fake.provision({ botId: "bot-a", homePath: "/tmp/a" }, ctx);
    const b = await fake.provision({ botId: "bot-b", homePath: "/tmp/b" }, ctx);
    for await (const event of fake.execute(
      a,
      { argv: ["sh", "-c", "echo shared-ok > /workspace/note.txt"] },
      ctx,
    )) {
      if (event.type === "exit") expect(event.code).toBe(0);
    }
    let stdout = "";
    for await (const event of fake.execute(b, { argv: ["cat", "/workspace/note.txt"] }, ctx)) {
      if (event.type === "stdout") stdout += event.data;
    }
    expect(stdout).toContain("shared-ok");
    const screenA = await fake.connectScreen(a, { view: "stream" }, ctx);
    const screenB = await fake.connectScreen(b, { view: "stream" }, ctx);
    expect(a.providerRef).toBe(b.providerRef);
    expect(screenA.url).not.toBe(screenB.url);
    await fake.sendInput(
      a,
      { kind: "clipboard", text: "from-a" },
      { leaseId: "a", holder: "user", fence: 1 },
      ctx,
    );
    await fake.sendInput(
      b,
      { kind: "clipboard", text: "from-b" },
      { leaseId: "b", holder: "user", fence: 1 },
      ctx,
    );
    expect(fake.session(a)?.screen).toBe("from-a");
    expect(fake.session(b)?.screen).toBe("from-b");
    await fake.destroy(a, ctx);
    await fake.destroy(b, ctx);
  });
});

describe("docker sandbox", () => {
  let spawned: ReturnType<typeof spawn> | undefined;
  // The workspace home is bind-mounted into the computer container, so it has to live somewhere the
  // Docker daemon can actually see. On macOS the daemon runs in a VM (Colima, Docker Desktop,
  // Rancher) that shares $HOME but not the host `/tmp`: a mkdtemp there binds an empty directory
  // and the graphical session dies with "framebuffer failed". Keeping it under the repo works on
  // every setup, because the repo is inside $HOME on macOS and is a plain path on Linux CI.
  // `data/` is gitignored, so a fresh CI checkout does not have it. mkdtempSync
  // requires the parent to exist; create it first.
  const dataRoot = path.join(path.resolve(import.meta.dirname, "../../.."), "data");
  mkdirSync(dataRoot, { recursive: true });
  const dataDir = mkdtempSync(path.join(dataRoot, "conformance-"));

  afterAll(async () => {
    spawned?.kill("SIGTERM");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("allocates DATA_DIR under the repo even when data/ was never checked in", () => {
    expect(existsSync(dataDir)).toBe(true);
    expect(dataDir.startsWith(dataRoot)).toBe(true);
  });

  it("runs the same graphical command through the supervisor", async ({ skip }) => {
    if (!dockerAvailable() || !hasAnySandboxImage()) {
      skip();
      return;
    }
    const port = await availablePort();
    const token = "sandbox-conformance-token";
    const url = `http://127.0.0.1:${port}`;
    const root = path.resolve(import.meta.dirname, "../../..");
    spawned = spawn("pnpm", ["--filter", "@quibt/sandbox-supervisor", "start"], {
      cwd: root,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        SANDBOX_SUPERVISOR_TOKEN: token,
        SUPERVISOR_PORT: String(port),
      },
      stdio: "ignore",
    });
    const up = await waitForHealth(`${url}/health`, 20_000);
    if (!up) {
      skip();
      return;
    }
    const provider = new DockerSandboxProvider(url, token);
    const botId = `conf-${Date.now()}`;
    const computer = await provider.provision(
      { botId, homePath: path.join(dataDir, "homes", botId) },
      ctx,
    );
    const out = await drain(provider, computer);
    expect(out).toContain("graphical-ok");
    const session = await provider.connectScreen(computer, { view: "stream" }, ctx);
    expect(session.url).toMatch(/embed\.html/);
    const second = await provider.provision(
      { botId: `${botId}-peer`, homePath: path.join(dataDir, "homes", `${botId}-peer`) },
      ctx,
    );
    expect(second.providerRef).toBe(computer.providerRef);
    const secondScreen = await provider.connectScreen(second, { view: "stream" }, ctx);
    expect(secondScreen.url).not.toBe(session.url);
    for await (const event of provider.execute(
      computer,
      { argv: ["bash", "-lc", "echo shared-docker > /workspace/shared.txt"] },
      ctx,
    )) {
      if (event.type === "exit") expect(event.code).toBe(0);
    }
    let shared = "";
    for await (const event of provider.execute(
      second,
      { argv: ["cat", "/workspace/shared.txt"] },
      ctx,
    )) {
      if (event.type === "stdout") shared += event.data;
    }
    expect(shared).toContain("shared-docker");
    await provider.destroy(computer, ctx);
    await provider.destroy(second, ctx);
  }, 60_000);
});

function dockerAvailable() {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

function hasAnySandboxImage() {
  try {
    execSync("docker image inspect quibt/computer:local", { stdio: "ignore", timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

async function ping(url: string) {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(url: string, ms: number) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await ping(url)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate test port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
