import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.dirname(fileURLToPath(import.meta.url));
const form = readFileSync(path.join(root, "CreateBotForm.tsx"), "utf8");
const shell = readFileSync(path.join(root, "Shell.tsx"), "utf8");

describe("in-app Novo bot uses the same generated designer as onboarding", () => {
  it("shows a live raster preview and the Personagem picker", () => {
    expect(form).toContain("BotAvatar");
    expect(form).toContain("CharacterPicker");
    expect(form).toContain("Personagem");
    expect(form).toContain("Como a marca deste bot aparece em todo lugar");
    expect(form).toContain("qb-dash__settings-avatar");
    expect(form).not.toContain("faceEngine");
    expect(form).not.toContain("MascotAvatar");
  });

  it("persists the chosen color and silhouette on create", () => {
    expect(form).toContain("formatAppearance");
    expect(form).toContain("DEFAULT_APPEARANCE");
    expect(form).toContain("color: formatAppearance({ color, shape })");
    expect(form).toContain("shape");
    expect(shell).toContain("color: input.color");
    expect(shell).toContain("shape: input.shape");
  });
});
