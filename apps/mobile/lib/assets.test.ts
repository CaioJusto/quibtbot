import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.join(dir, "..");

function source(relative: string) {
  return readFileSync(path.join(dir, relative), "utf8");
}

function sourceFiles(root: string): string[] {
  const skip = new Set(["node_modules", ".expo", ".turbo", "assets", "ios", "android"]);
  return readdirSync(root).flatMap((entry) => {
    if (skip.has(entry)) return [];
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(tsx?|jsx?|json)$/.test(entry) ? [full] : [];
  });
}

describe("mobile assets", () => {
  it("ships no image the app never asks for", () => {
    const code = sourceFiles(mobile)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const images = readdirSync(path.join(mobile, "assets")).filter((name) =>
      /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(name),
    );
    // Every image must be named by a `require`, by app.json, or by an EAS config —
    // Metro never bundles the rest, so they only make the clone heavier.
    expect(images.filter((name) => !code.includes(name))).toEqual([]);
    expect(images.length).toBeGreaterThan(0);
  });

  it("keeps Material Symbols out of the iOS font module", () => {
    expect(source("../app/_layout.tsx")).not.toContain("@expo-google-fonts/material-symbols");
    expect(source("./icon-font.ios.ts")).not.toContain("@expo-google-fonts/material-symbols");
    expect(source("./icon-font.ts")).toContain("@expo-google-fonts/material-symbols");
  });

  it("uses expo-image for remote mobile images", () => {
    for (const file of ["../app/index.tsx", "../app/account.tsx", "../app/plugins.tsx"]) {
      expect(source(file)).toContain('from "expo-image"');
    }
  });
});
