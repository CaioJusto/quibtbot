import { describe, expect, it } from "vitest";
import { appearanceLabel, isAppearanceChoice } from "./appearance-core";

describe("aparência (claro/escuro/sistema)", () => {
  it("aceita só os três valores e rotula em português", () => {
    expect(isAppearanceChoice("light")).toBe(true);
    expect(isAppearanceChoice("dark")).toBe(true);
    expect(isAppearanceChoice("system")).toBe(true);
    expect(isAppearanceChoice("blue")).toBe(false);
    expect(isAppearanceChoice(null)).toBe(false);
    expect(appearanceLabel("light")).toBe("Claro");
    expect(appearanceLabel("dark")).toBe("Escuro");
    expect(appearanceLabel("system")).toBe("Sistema");
  });
});
