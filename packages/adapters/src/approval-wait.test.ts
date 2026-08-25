import { describe, expect, it } from "vitest";
import { approvalCheckpoint, promptForRun, RESUME_AFTER_APPROVAL_PROMPT } from "./approval-wait.js";

describe("approvalCheckpoint", () => {
  it("round-trips the pending tool and the decision", () => {
    const raw = approvalCheckpoint(
      {
        requestId: "exec-1",
        tool: "shell",
        args: { command: "ls" },
        executionId: "exec-1",
        allowKey: "shell:ls",
        summary: "ls",
      },
      "always",
    );
    expect(JSON.parse(raw)).toMatchObject({
      decision: "always",
      pendingApproval: { tool: "shell", allowKey: "shell:ls" },
    });
  });
});

describe("promptForRun", () => {
  it("manda o pedido da pessoa num run comum", () => {
    expect(promptForRun("Rode ls no seu computador", false)).toBe("Rode ls no seu computador");
  });

  it("não repete o pedido depois de uma aprovação", () => {
    // Repetir a instrução fazia o modelo chamar a mesma ferramenta de novo, e o
    // card de aprovação voltava para sempre.
    expect(promptForRun("Rode ls no seu computador", true)).toBe(RESUME_AFTER_APPROVAL_PROMPT);
    expect(promptForRun("Rode ls no seu computador", true)).not.toContain("Rode ls");
  });
});
