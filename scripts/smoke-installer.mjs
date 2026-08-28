#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function spawnEnv() {
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const currentPath = process.env[pathKey] ?? process.env.PATH ?? "";
  const nodeBin = path.dirname(process.execPath);
  const pathPrefix = currentPath.split(path.delimiter).includes(nodeBin)
    ? currentPath
    : `${nodeBin}${path.delimiter}${currentPath}`;
  return { ...process.env, [pathKey]: pathPrefix };
}

/**
 * Onde procurar o pnpm, em ordem. `npm_execpath` é o caminho que o próprio pnpm
 * exporta quando ele é quem roda este script: chamá-lo com o Node atual dispensa o
 * PATH e o shim `.cmd` do Windows. Depois vem o PATH e, por último, o corepack — que
 * é como o pnpm chega no Node 22 sem `corepack enable`.
 */
export function pnpmCandidates(env = process.env, platform = process.platform) {
  const candidates = [];
  const execPath = env.npm_execpath;
  if (execPath && /\.[cm]?js$/i.test(execPath)) {
    candidates.push({ command: process.execPath, args: [execPath], shell: false });
  } else if (execPath) {
    candidates.push({ command: execPath, args: [], shell: false });
  }
  const shell = platform === "win32";
  candidates.push({ command: "pnpm", args: [], shell });
  candidates.push({ command: "corepack", args: ["pnpm"], shell });
  return candidates;
}

/** A falha tem de dizer o que aconteceu e o que instalar — nunca sair calada. */
export function missingPnpmMessage(args, error) {
  return [
    `Não deu para rodar "pnpm ${args.join(" ")}": ${error?.message ?? "erro desconhecido"}`,
    'Instale o pnpm 9 com "npm install -g pnpm@9", ou ligue o corepack com "corepack enable pnpm", e repita.',
  ];
}

function abort(lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

/**
 * Roda `pnpm <args>` e devolve o resultado. Sem checar `result.error`, um pnpm ausente
 * virava `status: null`, `process.exit(1)` e uma saída vazia — a pessoa não ficava
 * sabendo nem que o smoke não chegou a rodar.
 */
export function runPnpmSync(args, options = {}, deps = {}) {
  const spawn = deps.spawn ?? spawnSync;
  const fail = deps.fail ?? abort;
  const candidates = pnpmCandidates(deps.env, deps.platform);
  let lastError;
  for (const candidate of candidates) {
    const result = spawn(candidate.command, [...candidate.args, ...args], {
      ...options,
      shell: candidate.shell,
    });
    if (!result.error) return result;
    // Só "não achei o executável" merece a próxima tentativa; o resto é falha de verdade.
    if (result.error.code !== "ENOENT") return fail(missingPnpmMessage(args, result.error));
    lastError = result.error;
  }
  return fail(missingPnpmMessage(args, lastError));
}

function main() {
  const env = spawnEnv();

  const vitest = runPnpmSync(
    ["exec", "vitest", "run", "packages/testkit/src/installer-smoke.test.ts"],
    { cwd: root, stdio: "inherit", env },
  );
  if (vitest.status !== 0) {
    process.exit(vitest.status ?? 1);
  }

  const harness = runPnpmSync(["exec", "tsx", "packages/testkit/src/installer-smoke.harness.ts"], {
    cwd: root,
    stdio: "inherit",
    env,
  });
  process.exit(harness.status ?? 1);
}

// Só corre quando é ele o script chamado: os testes importam os auxiliares acima.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
