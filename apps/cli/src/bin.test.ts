import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALL_RELEASE } from "@quibt/installer";
import { describe, expect, it } from "vitest";

/**
 * O `bin` declarado no package.json é uma promessa pública: `npm link`, `pnpm exec
 * quibtbot` e qualquer publicação seguem esse caminho. Ele precisa RODAR depois do
 * build, sem depender de o Node achar (e conseguir apagar tipos de) o TypeScript
 * fonte de `@quibt/installer` — o que nem acontece dentro de node_modules.
 */

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(cliRoot, "package.json"), "utf8")) as {
  bin: Record<string, string>;
  scripts: Record<string, string>;
};
const binPath = path.join(cliRoot, manifest.bin.quibtbot ?? "");

function buildBin(): void {
  execFileSync(process.execPath, [path.join(cliRoot, "scripts/bundle.mjs")], {
    cwd: cliRoot,
    stdio: "pipe",
  });
}

function runBin(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [binPath, ...args], { encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

describe("quibtbot bin", () => {
  it("o build do pacote produz exatamente o arquivo declarado em bin", () => {
    expect(manifest.scripts.build).toContain("scripts/bundle.mjs");
    rmSync(binPath, { force: true });
    buildBin();
    expect(existsSync(binPath)).toBe(true);
  });

  it("o bin construído responde a --help", () => {
    if (!existsSync(binPath)) buildBin();
    const help = runBin(["--help"]);
    expect(help.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: quibtbot");
    expect(help.stdout).toContain("install");
  });

  it("o bin construído responde a --version com a release do instalador", () => {
    if (!existsSync(binPath)) buildBin();
    const version = runBin(["--version"]);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(INSTALL_RELEASE);
  });

  it("comando desconhecido sai com 2, e não com erro de carregamento", () => {
    if (!existsSync(binPath)) buildBin();
    const unknown = runBin(["chat"]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("unknown command: chat");
  });

  it("o bin sai executável, para valer como `./dist/main.js`", () => {
    if (!existsSync(binPath)) buildBin();
    if (process.platform === "win32") return;
    expect(statSync(binPath).mode & 0o111).toBeGreaterThan(0);
  });

  it("o bin não carrega fonte TypeScript de workspace em tempo de execução", () => {
    if (!existsSync(binPath)) buildBin();
    const code = readFileSync(binPath, "utf8");
    expect(code.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(code).not.toMatch(/@quibt\/installer\/src/);
    expect(code).not.toMatch(/from ["'][^"']*\.ts["']/);
    expect(code).not.toMatch(/require\(["'][^"']*\.ts["']\)/);
    expect(code.length).toBeGreaterThan(10_000);
  });
});
