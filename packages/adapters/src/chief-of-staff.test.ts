import { describe, expect, it } from "vitest";
import { chiefOfStaffSystemPrompt, isChiefOfStaff } from "./chief-of-staff.js";

describe("Chief of Staff", () => {
  it("recognizes the default title and name", () => {
    expect(isChiefOfStaff({ name: "Chief", title: "Chief of staff" })).toBe(true);
    expect(isChiefOfStaff({ name: "Finn", title: "Eng" })).toBe(false);
  });

  it("lists teammates and tells the chief to wait for real replies", () => {
    const prompt = chiefOfStaffSystemPrompt(
      "chief",
      [
        { id: "chief", name: "Chief", title: "Chief of staff" },
        { id: "coder", name: "Coder", title: "Engineer", description: "Writes code" },
      ],
      true,
    );
    expect(prompt).toMatch(/Chief of Staff/);
    expect(prompt).toContain("Coder — Engineer: Writes code (available)");
    expect(prompt).toMatch(/message_teammate|spawn_bot/);
    expect(prompt).not.toContain("Chief —");
  });
});
