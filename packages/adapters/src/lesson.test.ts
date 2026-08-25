import { describe, expect, it } from "vitest";
import {
  LESSON_MARKER,
  LESSON_MAX_ITEMS,
  lessonCaptureCommand,
  lessonStartCommand,
  parseLessonCapture,
} from "./lesson.js";

describe("lesson markers", () => {
  it("writes the line count of the history, not just the clock", () => {
    const [, , script] = lessonStartCommand();
    // Sem a contagem, o que já estava no .bash_history entraria como se fosse da lição.
    expect(script).toContain(".bash_history");
    expect(script).toContain("histLines");
    expect(script).toContain(LESSON_MARKER);
  });

  it("runs the capture through python, where sqlite already lives", () => {
    const [, , script] = lessonCaptureCommand();
    expect(script).toContain("python3");
    expect(script).toContain("chromium/Default/History");
    // O epoch do Chromium começa em 1601; sem o deslocamento nada seria recente.
    expect(script).toContain("11644473600");
    expect(script).toContain(".bash_history");
    expect(script).toContain("-newermt");
  });

  it("keeps the heredoc quoted so the shell does not eat the script", () => {
    const [, , script] = lessonCaptureCommand();
    expect(script).toContain("<<'QUIBT_LESSON_PY'");
  });
});

describe("parseLessonCapture", () => {
  it("reads the json line even with noise around it", () => {
    const parsed = parseLessonCapture(
      'bash: aviso qualquer\n{"urls":["a"],"commands":["ls"],"files":[],"windows":[],"startedAt":"x"}\n',
    );
    expect(parsed).toEqual({
      urls: ["a"],
      commands: ["ls"],
      files: [],
      windows: [],
      startedAt: "x",
    });
  });

  it("never throws on garbage; it says it could not read", () => {
    expect(parseLessonCapture("").error).toBe("sem resposta");
    expect(parseLessonCapture("{nao é json}").error).toBe("resposta ilegível");
  });
});

describe("limits", () => {
  it("caps each list so a long session does not flood the prompt", () => {
    const [, , script] = lessonCaptureCommand();
    expect(script).toContain(`MAX = ${LESSON_MAX_ITEMS}`);
  });
});
