import { WORKER_DOWN_MESSAGE } from "@quibt/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkerDownNotice, workerAliveRefresher } from "./WorkerDownNotice";

describe("WorkerDownNotice", () => {
  it("só aparece quando a API disse que o worker não está rodando", () => {
    expect(renderToStaticMarkup(<WorkerDownNotice alive={null} />)).toBe("");
    expect(renderToStaticMarkup(<WorkerDownNotice alive={true} />)).toBe("");
    const html = renderToStaticMarkup(<WorkerDownNotice alive={false} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain(WORKER_DOWN_MESSAGE);
  });

  it("veste os tokens do sistema, sem cor solta", () => {
    const html = renderToStaticMarkup(<WorkerDownNotice alive={false} />);
    expect(html).toContain("var(--qb-danger-soft)");
    expect(html).toContain("var(--qb-t-sm)");
    expect(html).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});

describe("workerAliveRefresher", () => {
  it("pergunta me na primeira volta e depois só quando passou a cadência", async () => {
    let clock = 0;
    const loadMe = vi.fn(async () => ({ worker: { alive: false } }));
    const seen: boolean[] = [];
    const refresh = workerAliveRefresher(loadMe, (alive) => seen.push(alive), {
      everyMs: 15_000,
      now: () => clock,
    });
    await refresh();
    clock = 4_000;
    await refresh();
    clock = 12_000;
    await refresh();
    expect(loadMe).toHaveBeenCalledTimes(1);
    clock = 15_000;
    await refresh();
    expect(loadMe).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([false, false]);
  });

  it("um servidor antigo sem o campo conta como vivo; uma falha de rede não muda nada", async () => {
    const seen: boolean[] = [];
    const old = workerAliveRefresher(
      async () => ({}),
      (alive) => seen.push(alive),
      {
        now: () => 0,
      },
    );
    await old();
    expect(seen).toEqual([true]);
    const broken = workerAliveRefresher(
      async () => {
        throw new Error("Failed to fetch");
      },
      (alive) => seen.push(alive),
      { now: () => 0 },
    );
    await broken();
    expect(seen).toEqual([true]);
  });
});
