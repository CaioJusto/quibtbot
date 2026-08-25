import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const screen = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../app/scan.tsx"),
  "utf8",
);

describe("mobile QR scanner fallback", () => {
  it("opens the server form when the user chooses to type an address", () => {
    expect(screen.match(/router\.push\("\/server"\)/g)).toHaveLength(2);
  });

  it("keeps camera chrome readable on the dark viewfinder", () => {
    expect(screen).toMatch(/cameraTitle:\s*\{[\s\S]*?color: "#FFFFFF"/);
    expect(screen).toMatch(/cameraLink:\s*\{[\s\S]*?color: "#FFFFFF"/);
    expect(screen).toContain('backgroundColor: "rgba(0, 0, 0, 0.62)"');
  });
});
