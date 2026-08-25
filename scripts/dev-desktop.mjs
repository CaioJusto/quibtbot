#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: documented override for the local stack URL
const url = process.env.QUIBT_WEB_URL ?? "http://127.0.0.1:5173";
const shell = process.platform === "win32";

async function main() {
  console.log(`Waiting for ${url} …`);
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const child = spawn("pnpm", ["--filter", "@quibt/desktop", "dev"], {
          cwd: root,
          stdio: "inherit",
          shell,
        });
        child.on("exit", (code) => process.exit(code ?? 1));
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

await main();
