import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "MachineGuide.tsx"),
  "utf8",
);

describe("MachineGuide", () => {
  it("renders the shared core guide instead of inventing copy", () => {
    expect(src).toContain("machineGuideFor");
    expect(src).toContain("O que você precisa");
    expect(src).toContain("O que fazer agora");
    expect(src).toContain("Vários bots");
    expect(src).toContain("guide.signupUrl");
    expect(src).toContain("guide.keyUrl");
  });
});
