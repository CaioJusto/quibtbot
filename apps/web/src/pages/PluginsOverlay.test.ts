import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "PluginsOverlay.tsx"),
  "utf8",
);

describe("plugins callback page", () => {
  const callback = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "PluginsCallback.tsx"),
    "utf8",
  );

  it("opens the native app when the provider bounced through the website", () => {
    expect(callback).toContain("window.location.assign(href)");
    expect(callback).toContain("quibt://plugins/callback?connectionId=");
    expect(callback).toContain("bg-[var(--qb-canvas)]");
  });
});

describe("plugins overlay", () => {
  it("stops polling for a connection when the overlay closes", () => {
    expect(src).toContain("cancelled: () => !open.current");
    expect(src).toContain("open.current = false");
    // The old inline loop kept calling the API for 90s after unmount.
    expect(src).not.toContain("for (let i = 0; i < 45");
  });

  it("says something when the skills list is empty", () => {
    expect(src).toContain("skills.length === 0");
    expect(src).toContain("Nenhuma skill ainda");
  });
});
