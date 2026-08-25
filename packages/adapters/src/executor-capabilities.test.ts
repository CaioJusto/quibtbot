import { formatSkillPrompt } from "@quibt/core";
import { describe, expect, it } from "vitest";
import { connectedProviderSlugs, instructionOnlyInstalls } from "./executor.js";

describe("executor capability routing", () => {
  const installs = [
    { kind: "connection", name: "Gmail connection", source: "gmail" },
    { kind: "plugin", name: "GitHub plugin", source: "github" },
    { kind: "skill", name: "Writer", source: "writer" },
    { kind: "mcp", name: "Local MCP", source: "local-mcp" },
  ];

  it("discovers tools for Connection rows plus connection and plugin installs", () => {
    expect(
      connectedProviderSlugs([{ provider: "slack" }, { provider: "gmail" }], installs),
    ).toEqual(["slack", "gmail", "github"]);
  });

  it("keeps only skills as instruction-only; MCP has a runtime", () => {
    expect(instructionOnlyInstalls(installs).map((row) => row.kind)).toEqual(["skill"]);
  });

  it("turns a saved skill into a slash-invokable prompt", () => {
    expect(
      formatSkillPrompt([
        {
          name: "Writer",
          source: "writer",
          config: { instructions: "Write in the user's voice." },
        },
      ]),
    ).toContain("/Writer");
  });
});
