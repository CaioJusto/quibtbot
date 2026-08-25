import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { filterSelectOptions, type SelectOption, selectedOptionLabel } from "./select-options";

const dir = path.dirname(fileURLToPath(import.meta.url));

const MODELS: SelectOption[] = [
  { id: "deepseek/deepseek-v4", label: "DeepSeek V4", hint: "deepseek/deepseek-v4" },
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { id: "google/gemini-3-pro", label: "Gemini 3 Pro" },
  { id: "mistral/codestral", label: "Codestral" },
];

describe("filterSelectOptions", () => {
  it("returns everything when nothing was typed", () => {
    expect(filterSelectOptions(MODELS, "")).toHaveLength(4);
    expect(filterSelectOptions(MODELS, "   ")).toHaveLength(4);
  });

  it("matches on the id, not only on the name", () => {
    // Quem já usa OpenRouter conhece o modelo pelo id que cola na configuração.
    expect(filterSelectOptions(MODELS, "google/").map((o) => o.id)).toEqual([
      "google/gemini-3-pro",
    ]);
  });

  it("takes every term, in any order and in either field", () => {
    expect(filterSelectOptions(MODELS, "anthropic haiku").map((o) => o.id)).toEqual([
      "anthropic/claude-haiku-4.5",
    ]);
    expect(filterSelectOptions(MODELS, "haiku anthropic")).toHaveLength(1);
  });

  it("ignores case and accents", () => {
    expect(filterSelectOptions([{ id: "x", label: "Máquina" }], "maquina")).toHaveLength(1);
    expect(filterSelectOptions(MODELS, "CODESTRAL")).toHaveLength(1);
  });

  it("answers nothing when nothing matches", () => {
    expect(filterSelectOptions(MODELS, "llama")).toEqual([]);
  });
});

describe("selectedOptionLabel", () => {
  it("shows the chosen option's name on the closed field", () => {
    expect(selectedOptionLabel(MODELS, "google/gemini-3-pro")).toBe("Gemini 3 Pro");
  });

  it("falls back to the raw id for a model the catalogue no longer lists", () => {
    expect(selectedOptionLabel(MODELS, "openai/gpt-6")).toBe("openai/gpt-6");
  });

  it("prompts when nothing is chosen", () => {
    expect(selectedOptionLabel(MODELS, null)).toBe("Escolher");
    expect(selectedOptionLabel(MODELS, "", "Nenhum modelo")).toBe("Nenhum modelo");
  });
});

describe("the long lists are gone from the model screens", () => {
  it("Conta e onboarding escolhem o modelo por select, não por lista aberta", () => {
    // O catálogo do OpenRouter passa de trezentos modelos: listados em linha, empurravam a
    // chave e o botão de continuar para fora da tela.
    const card = readFileSync(path.join(dir, "model-source.tsx"), "utf8");
    expect(card).toMatch(/<SelectField\s+label="Modelo"/);
    expect(card).toMatch(/<SelectField\s+label="Provedor"/);
    expect(card).toContain("options={modelOptions}");
    expect(card).toContain("options={providerOptions}");

    const onboarding = readFileSync(path.join(dir, "../app/onboarding.tsx"), "utf8");
    expect(onboarding).toMatch(/<SelectField\s+label="Modelo"/);
  });
});
