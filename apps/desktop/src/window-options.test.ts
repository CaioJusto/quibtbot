import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { browserWindowOptions } from "./window-options.js";

describe("desktop window chrome", () => {
  it("uses native traffic lights on macOS", () => {
    const opts = browserWindowOptions("darwin");
    expect(opts.frame).toBe(true);
    expect(opts.titleBarStyle).toBe("hiddenInset");
    expect(opts.trafficLightPosition).toEqual({ x: 16, y: 16 });
  });

  it("is frameless on Windows and Linux so in-app buttons control the window", () => {
    for (const platform of ["win32", "linux"] as const) {
      const opts = browserWindowOptions(platform);
      expect(opts.frame).toBe(false);
      expect(opts.titleBarStyle).toBeUndefined();
    }
  });
});

describe("desktop installers", () => {
  it("names the Linux AppImage without a space so GitHub Releases match the landing URL", () => {
    const pkg = JSON.parse(
      readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
        "utf8",
      ),
    ) as {
      build: {
        linux: { artifactName: string };
        dmg: {
          artifactName: string;
          background: string;
          iconSize: number;
          contents: Array<{ x: number; y: number; type?: string; path?: string }>;
        };
        nsis: { artifactName: string };
      };
    };
    expect(pkg.build.linux.artifactName).toBe(`QuibtBot-\${version}.AppImage`);
    expect(pkg.build.dmg.artifactName).toBe(`QuibtBot-\${version}.dmg`);
    expect(pkg.build.dmg.background).toBe("assets/dmg-background.png");
    expect(pkg.build.dmg.iconSize).toBe(92);
    expect(pkg.build.dmg.contents).toEqual([
      { x: 170, y: 238 },
      { x: 490, y: 238, type: "link", path: "/Applications" },
    ]);
    expect(pkg.build.nsis.artifactName).toBe(`QuibtBot-\${version}-setup.\${ext}`);
  });
});
