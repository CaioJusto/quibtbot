import { describe, expect, it } from "vitest";
import { formatMemoryPrompt, formatSkillPrompt, skillBody } from "./skills.js";

describe("skillBody", () => {
  it("prefers config.instructions over the source slug", () => {
    expect(
      skillBody({
        name: "Weekly health",
        source: "weekly-health",
        config: { instructions: "Pull churn signals. Never email a customer." },
      }),
    ).toBe("Pull churn signals. Never email a customer.");
  });

  it("falls back to source when no instructions are stored", () => {
    expect(skillBody({ name: "Writer", source: "Write in the user's voice." })).toBe(
      "Write in the user's voice.",
    );
  });
});

describe("formatSkillPrompt", () => {
  it("returns empty when there is nothing to teach", () => {
    expect(formatSkillPrompt([])).toBe("");
    expect(formatSkillPrompt([{ name: "Empty", source: "  " }])).toBe("");
  });

  it("lists slash names and the skill body", () => {
    const prompt = formatSkillPrompt([
      {
        name: "Weekly health",
        source: "weekly-health",
        config: { instructions: "Flag churn. Ask before contacting anyone." },
      },
    ]);
    expect(prompt).toContain("/Weekly health");
    expect(prompt).toContain("Flag churn. Ask before contacting anyone.");
    expect(prompt).toContain("When the user types /Name");
  });

  it("keeps one block per slash name so the model is never given two /Deploy", () => {
    const prompt = formatSkillPrompt([
      { name: "Deploy", source: "ship it the careful way" },
      { name: " deploy ", source: "ship it the reckless way" },
    ]);
    expect(prompt).toContain("ship it the careful way");
    expect(prompt).not.toContain("ship it the reckless way");
    expect(prompt.match(/### \/\s*[Dd]eploy/g)).toHaveLength(1);
  });
});

describe("formatMemoryPrompt", () => {
  it("skips empty MEMORY.md shells", () => {
    expect(formatMemoryPrompt([{ scope: "bot", path: "MEMORY.md", content: "# Ada\n\n" }])).toBe(
      "",
    );
  });

  it("includes facts the bot should keep using", () => {
    const prompt = formatMemoryPrompt([
      { scope: "bot", path: "MEMORY.md", content: "# Ada\n\n- Prefers Rust\n" },
      { scope: "user", path: "MEMORY.md", content: "- Timezone America/Sao_Paulo\n" },
    ]);
    expect(prompt).toContain("MEMORY (your personal notes)");
    expect(prompt).toContain("USER PROFILE (who the user is)");
    expect(prompt).toContain("Prefers Rust");
    expect(prompt).toContain("America/Sao_Paulo");
    expect(prompt).toContain("memory tool");
    expect(prompt).not.toContain("bot/MEMORY.md");
  });

  it("prefers USER.md over the legacy account MEMORY.md", () => {
    const prompt = formatMemoryPrompt([
      { scope: "user", path: "MEMORY.md", content: "old timezone" },
      { scope: "user", path: "USER.md", content: "Timezone America/Sao_Paulo" },
    ]);
    expect(prompt).toContain("America/Sao_Paulo");
    expect(prompt).not.toContain("old timezone");
  });
});
