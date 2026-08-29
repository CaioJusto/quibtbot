#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: documented override for the local stack URL
const url = process.env.QUIBT_WEB_URL ?? "http://127.0.0.1:5173";

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
    'Instale o pnpm 10.34.5 com "npm install -g pnpm@10.34.5", ou ligue o corepack com "corepack enable pnpm", e repita.',
  ];
}

function abort(lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

/**
 * Sobe `pnpm <args>`. Sem o ouvinte de `error`, um pnpm fora do PATH derrubava este
 * script com um ENOENT cru, logo depois de dizer que a stack estava no ar.
 */
export function startPnpm(args, options = {}, deps = {}) {
  const spawnImpl = deps.spawn ?? spawn;
  const fail = deps.fail ?? abort;
  const candidates = pnpmCandidates(deps.env, deps.platform);
  const { onExit, ...spawnOptions } = options;

  const attempt = (index) => {
    const candidate = candidates[index];
    const child = spawnImpl(candidate.command, [...candidate.args, ...args], {
      ...spawnOptions,
      shell: candidate.shell,
    });
    child.on("error", (error) => {
      // Só "não achei o executável" merece a próxima tentativa; o resto é falha de verdade.
      if (error.code === "ENOENT" && index + 1 < candidates.length) {
        attempt(index + 1);
        return;
      }
      fail(missingPnpmMessage(args, error));
    });
    if (onExit) child.on("exit", onExit);
    return child;
  };

  return attempt(0);
}

async function main() {
  console.log(`Waiting for ${url} …`);
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        startPnpm(["--filter", "@quibt/desktop", "dev"], {
          cwd: root,
          stdio: "inherit",
          onExit: (code) => process.exit(code ?? 1),
        });
        return;
      }
    } catch {
      // The stack is still coming up.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.error(`The local Quibt Bot stack is not up at ${url}.`);
  console.error(
    "In another terminal: copy .env.example to .env, start Postgres with Docker Compose, then pnpm install && pnpm db:generate && pnpm db:migrate && pnpm dev",
  );
  process.exit(1);
}

// Só corre quando é ele o script chamado: os testes importam os auxiliares acima.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
