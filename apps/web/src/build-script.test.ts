import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("web production build launcher", () => {
  it("sets NODE_ENV before dynamically importing Vite", () => {
    const source = readFileSync(path.resolve("apps/web/scripts/build.mjs"), "utf8");
    expect(source.indexOf('process.env.NODE_ENV = "production"')).toBeGreaterThan(-1);
    expect(source.indexOf('process.env.NODE_ENV = "production"')).toBeLessThan(
      source.indexOf('import("vite")'),
    );
  });

  it("precompresses production assets before packaging the server", () => {
    const source = readFileSync(path.resolve("apps/web/scripts/build.mjs"), "utf8");
    expect(source).toContain("brotliCompress");
    expect(source).toContain("gzipFile");
    expect(source.indexOf('await precompress("dist")')).toBeLessThan(
      source.indexOf("await esbuildBuild"),
    );
  });
});
