import { describe, expect, it } from "vitest";
import { chiefOfStaffSystemPrompt } from "./chief-of-staff.js";

describe("chiefOfStaffSystemPrompt", () => {
  it("lists the other bots and tells the chief to use ask_bot", () => {
    const prompt = chiefOfStaffSystemPrompt(
      "chief",
      [
        { id: "chief", name: "Chefe", title: "COO" },
        { id: "fin", name: "Fin", title: "Financeiro", description: "Contas", busy: true },
      ],
      true,
    );
    expect(prompt).toContain("chefe de gabinete");
    expect(prompt).toContain("ask_bot");
    expect(prompt).toContain("Fin — Financeiro (ocupado) [fin]");
    expect(prompt).not.toMatch(/- Chefe/);
  });

  it("does not promise delegation when the tools are missing", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", [{ id: "chief", name: "Chefe" }], false);
    expect(prompt).toContain("não dá para falar");
    expect(prompt).toContain("nenhum outro bot");
  });
});
