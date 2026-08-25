import { copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

await esbuild.build({
  entryPoints: [path.join(root, "src/main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: path.join(root, "dist/main.js"),
  external: ["electron", "ssh2", "cpu-features"],
  packages: "bundle",
  logLevel: "info",
});

copyFileSync(
  path.join(root, "assets/release-manifest.json"),
  path.join(root, "dist/release-manifest.json"),
);
