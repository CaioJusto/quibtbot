import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(path.join(here, "Shell.tsx"), "utf8");

describe("teach a task", () => {
  it("lives in the composer plus menu, next to attaching files", () => {
    expect(shell).toContain("Anexar arquivos");
    expect(shell).toContain("Ensinar uma tarefa");
    expect(shell).toContain("qb-composer-menu");
  });

  it("takes control before marking the start: without the mouse there is nothing to teach", () => {
    const start = shell.slice(shell.indexOf("async function startTeaching"));
    expect(start.slice(0, 600)).toContain("takeOverComputer");
    expect(start.slice(0, 600)).toContain("teachStart");
  });

  it("hands the draft back to the person instead of sending it by itself", () => {
    const finish = shell.slice(shell.indexOf("async function finishTeaching"));
    const body = finish.slice(0, 1200);
    expect(body).toContain("teachCapture");
    expect(body).toContain("lessonPrompt");
    expect(body).toContain("setDraft(prompt)");
    // Nada de `send()` aqui: quem decide o que vira skill é quem ensinou.
    expect(body).not.toContain("void send(");
  });

  it("says plainly when the session had nothing to capture", () => {
    expect(shell).toContain("Não vi páginas, comandos nem arquivos nessa sessão");
  });
});
