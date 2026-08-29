#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

// The repository's local `.env` deliberately says development. Vite resolves React's
// conditional exports while it starts, before vite.config.ts can override anything. Set
// production before importing Vite so a local `pnpm build` cannot ship ReactDOM's dev build.
process.env.NODE_ENV = "production";

const [{ build: viteBuild }, { build: esbuildBuild }] = await Promise.all([
  import("vite"),
  import("esbuild"),
]);

await viteBuild();

const brotli = promisify(brotliCompress);
const gzipFile = promisify(gzip);
const compressibleExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".mjs",
  ".svg",
  ".txt",
  ".wasm",
]);

async function precompress(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await precompress(file);
      continue;
    }
    if (!entry.isFile() || !compressibleExtensions.has(path.extname(entry.name))) continue;
    const contents = await readFile(file);
    if (contents.length < 1_024) continue;
    const [br, gz] = await Promise.all([
      brotli(contents, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }),
      gzipFile(contents, { level: 6 }),
    ]);
    await Promise.all([writeFile(`${file}.br`, br), writeFile(`${file}.gz`, gz)]);
  }
}

await precompress("dist");
await esbuildBuild({
  entryPoints: ["src/server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist-server/server.js",
  logLevel: "info",
});
