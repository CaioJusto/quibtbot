import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

function patchedImageSizeRoot(): string {
  const store = path.resolve(process.cwd(), "node_modules/.pnpm");
  const metro = readdirSync(store).find((entry) => entry.startsWith("metro@"));
  if (!metro) throw new Error("Metro is not installed");
  const metroRequire = createRequire(path.join(store, metro, "node_modules/metro/package.json"));
  return path.dirname(metroRequire.resolve("image-size/package.json"));
}

describe("patched image-size parser", () => {
  it("rejects zero-length ICNS entries without blocking the event loop", () => {
    const packageRoot = patchedImageSizeRoot();
    const script = `
      const { imageSize } = require(${JSON.stringify(packageRoot)});
      const input = Buffer.alloc(16);
      input.write("icns", 0);
      input.writeUInt32BE(16, 4);
      input.write("ic07", 8);
      input.writeUInt32BE(0, 12);
      try { imageSize(input); } catch { process.exit(0); }
      process.exit(1);
    `;
    const result = spawnSync(process.execPath, ["-e", script], { timeout: 1_000 });
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
  });

  it("rejects zero-sized JXL or HEIF boxes without looping", () => {
    const utils = path.join(patchedImageSizeRoot(), "dist/types/utils.js");
    const script = `
      const { findBox } = require(${JSON.stringify(utils)});
      const input = Buffer.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70]);
      process.exit(findBox(input, "meta", 0) === undefined ? 0 : 1);
    `;
    const result = spawnSync(process.execPath, ["-e", script], { timeout: 1_000 });
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
  });
});
