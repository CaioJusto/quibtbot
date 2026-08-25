import { describe, expect, it, vi } from "vitest";
import type { ThreadEvent } from "./api";
import { createProgressCadence, isProgressEvent } from "./progress-cadence.js";

function progress(text: string): ThreadEvent {
  return { type: "thread.progress", payload: { text } } as unknown as ThreadEvent;
}
function done(): ThreadEvent {
  return { type: "run.completed" } as unknown as ThreadEvent;
}

describe("createProgressCadence", () => {
  it("junta uma rajada de progress num flush só, com o texto mais recente", () => {
    vi.useFakeTimers();
    const applied: ThreadEvent[] = [];
    const cadence = createProgressCadence((e) => applied.push(e), { flushMs: 60 });
    cadence.push(progress("a"));
    cadence.push(progress("ab"));
    cadence.push(progress("abc"));
    expect(applied).toHaveLength(0); // nada pintou ainda
    vi.advanceTimersByTime(60);
    expect(applied).toHaveLength(1);
    expect((applied[0] as unknown as { payload: { text: string } }).payload.text).toBe("abc");
    vi.useRealTimers();
  });

  it("um evento estrutural descarrega o progress pendente antes de si, na ordem", () => {
    vi.useFakeTimers();
    const applied: ThreadEvent[] = [];
    const cadence = createProgressCadence((e) => applied.push(e), { flushMs: 60 });
    cadence.push(progress("parcial"));
    cadence.push(done()); // não espera o timer
    expect(applied.map((e) => e.type)).toEqual(["thread.progress", "run.completed"]);
    expect((applied[0] as unknown as { payload: { text: string } }).payload.text).toBe("parcial");
    vi.advanceTimersByTime(60); // o timer cancelado não dispara um flush vazio
    expect(applied).toHaveLength(2);
    vi.useRealTimers();
  });

  it("um novo progress depois do flush reagenda o timer", () => {
    vi.useFakeTimers();
    const applied: ThreadEvent[] = [];
    const cadence = createProgressCadence((e) => applied.push(e), { flushMs: 60 });
    cadence.push(progress("um"));
    vi.advanceTimersByTime(60);
    cadence.push(progress("um dois"));
    vi.advanceTimersByTime(60);
    expect(
      applied.map((e) => (e as unknown as { payload: { text: string } }).payload.text),
    ).toEqual(["um", "um dois"]);
    vi.useRealTimers();
  });

  it("dispose cancela o timer: nada pinta depois de sair da tela", () => {
    vi.useFakeTimers();
    const applied: ThreadEvent[] = [];
    const cadence = createProgressCadence((e) => applied.push(e), { flushMs: 60 });
    cadence.push(progress("x"));
    cadence.dispose();
    vi.advanceTimersByTime(200);
    expect(applied).toHaveLength(0);
    vi.useRealTimers();
  });

  it("classifica só thread.progress como acumulável", () => {
    expect(isProgressEvent("thread.progress")).toBe(true);
    for (const t of ["thread.message.created", "run.completed", "run.failed", "thread.cleared"]) {
      expect(isProgressEvent(t)).toBe(false);
    }
  });
});
