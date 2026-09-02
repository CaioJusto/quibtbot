import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectLocalCliEngines,
  EXTRA_ACP_CLI_ENV,
  EXTRA_ACP_CLI_ID,
  localCliCatalog,
  parseExtraAcpCliPath,
  resolveExtraAcpCli,
  resolveLocalCli,
} from "./local-cli.js";

const created: string[] = [];

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "quibt-cli-detect-"));
  created.push(dir);
  return dir;
}

async function fakeBinary(dir: string, name: string) {
  const file = path.join(dir, name);
  await writeFile(file, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(file, 0o755);
  return file;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("host CLI detection", () => {
  it("finds only present supported binaries on PATH", async () => {
    const bin = await tempDir();
    await fakeBinary(bin, "claude");
    await fakeBinary(bin, "grok");

    const detected = await detectLocalCliEngines({
      env: { PATH: bin },
      homeDir: path.join(bin, "empty-home"),
    });

    expect(detected.map((entry) => entry.id)).toEqual(["claude", "grok"]);
    expect(localCliCatalog(detected).map((entry) => entry.label)).toEqual(["Claude Code", "Grok"]);
  });

  it("also checks ~/.local/bin and /usr/local/bin-style explicit locations", async () => {
    const home = await tempDir();
    const localBin = path.join(home, ".local", "bin");
    await mkdir(localBin, { recursive: true });
    const executable = await fakeBinary(localBin, "codex");

    await expect(resolveLocalCli("codex", { env: { PATH: "" }, homeDir: home })).resolves.toBe(
      executable,
    );
  });

  it("reports absent binaries and refuses unknown executable names", async () => {
    const empty = await tempDir();
    await expect(detectLocalCliEngines({ env: { PATH: empty }, homeDir: empty })).resolves.toEqual(
      [],
    );
    await expect(resolveLocalCli("bash", { env: { PATH: "/bin" } })).resolves.toBeNull();
  });

  it("registers one extra ACP CLI only from a safe absolute path that exists", async () => {
    const home = await tempDir();
    const localBin = path.join(home, ".local", "bin");
    await mkdir(localBin, { recursive: true });
    const executable = await fakeBinary(localBin, "my-agent");

    const detected = await detectLocalCliEngines({
      env: { PATH: "", [EXTRA_ACP_CLI_ENV]: executable },
      homeDir: home,
    });

    expect(detected).toContainEqual({
      id: EXTRA_ACP_CLI_ID,
      label: "my-agent",
      path: executable,
    });
    expect(localCliCatalog(detected).map((entry) => entry.id)).toContain(EXTRA_ACP_CLI_ID);
    await expect(
      resolveLocalCli(EXTRA_ACP_CLI_ID, { extraAcpCli: executable, homeDir: home }),
    ).resolves.toBe(executable);
  });

  it("treats a missing extra ACP binary as unavailable and never throws", async () => {
    const home = await tempDir();
    const missing = path.join(home, ".local", "bin", "ghost-agent");
    await expect(
      detectLocalCliEngines({
        env: { PATH: home, [EXTRA_ACP_CLI_ENV]: missing },
        homeDir: home,
      }),
    ).resolves.toEqual([]);
    await expect(resolveExtraAcpCli({ extraAcpCli: missing, homeDir: home })).resolves.toBeNull();
    await expect(
      resolveLocalCli(EXTRA_ACP_CLI_ID, { extraAcpCli: missing, homeDir: home }),
    ).resolves.toBeNull();
  });

  it("refuses unknown extra ACP paths and shell metacharacters", () => {
    const home = "/home/quibt";
    expect(parseExtraAcpCliPath("/bin/bash", { homeDir: home })).toBeNull();
    expect(parseExtraAcpCliPath("/usr/local/bin/foo;rm", { homeDir: home })).toBeNull();
    expect(parseExtraAcpCliPath("/usr/local/bin/foo$(id)", { homeDir: home })).toBeNull();
    expect(parseExtraAcpCliPath("~/.local/bin/agent", { homeDir: home })).toBeNull();
    expect(parseExtraAcpCliPath("my-agent", { homeDir: home })).toBeNull();
    expect(parseExtraAcpCliPath("/usr/local/bin/../bin/bash", { homeDir: home })).toBeNull();
    expect(parseExtraAcpCliPath("/usr/local/bin/good-agent", { homeDir: home })).toBe(
      "/usr/local/bin/good-agent",
    );
    expect(parseExtraAcpCliPath(`${home}/.local/bin/good-agent`, { homeDir: home })).toBe(
      `${home}/.local/bin/good-agent`,
    );
  });
});
