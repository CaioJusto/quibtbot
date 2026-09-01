import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectLocalCliEngines, localCliCatalog, resolveLocalCli } from "./local-cli.js";

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
});
