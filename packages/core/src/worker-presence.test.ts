import { describe, expect, it } from "vitest";
import {
  QUEUED_RUN_PATIENCE_MS,
  queuedRunAbandoned,
  WORKER_ALIVE_MS,
  WORKER_DOWN_MESSAGE,
  WORKER_GONE_MS,
  WORKER_HEARTBEAT_MS,
  workerGone,
  workerPresence,
} from "./worker-presence.js";

const now = new Date("2026-08-25T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("workerPresence", () => {
  it("nunca visto é morto, sem data", () => {
    expect(workerPresence(null, now)).toEqual({ alive: false, lastSeenAt: null });
    expect(workerPresence(undefined, now)).toEqual({ alive: false, lastSeenAt: null });
  });

  it("visto há menos de 60 s é vivo; depois disso, não", () => {
    expect(workerPresence(ago(WORKER_HEARTBEAT_MS), now)).toEqual({
      alive: true,
      lastSeenAt: ago(WORKER_HEARTBEAT_MS).toISOString(),
    });
    expect(workerPresence(ago(WORKER_ALIVE_MS - 1), now).alive).toBe(true);
    expect(workerPresence(ago(WORKER_ALIVE_MS), now).alive).toBe(false);
    expect(workerPresence(ago(WORKER_ALIVE_MS), now).lastSeenAt).toBe(
      ago(WORKER_ALIVE_MS).toISOString(),
    );
  });

  it("os prazos têm folga entre si: batimento < vivo < sumido", () => {
    expect(WORKER_HEARTBEAT_MS).toBeLessThan(WORKER_ALIVE_MS);
    expect(WORKER_ALIVE_MS).toBeLessThan(WORKER_GONE_MS);
    expect(WORKER_GONE_MS).toBeLessThan(QUEUED_RUN_PATIENCE_MS);
  });
});

describe("workerGone", () => {
  it("só depois de 90 s sem sinal, ou quando nunca houve worker", () => {
    expect(workerGone(null, now)).toBe(true);
    expect(workerGone(ago(WORKER_GONE_MS), now)).toBe(false);
    expect(workerGone(ago(WORKER_GONE_MS + 1), now)).toBe(true);
  });
});

describe("queuedRunAbandoned", () => {
  it("um run recém-enfileirado espera, mesmo sem worker", () => {
    expect(
      queuedRunAbandoned({ queuedAt: ago(QUEUED_RUN_PATIENCE_MS), workerSeenAt: null, now }),
    ).toBe(false);
  });

  it("um run na fila há mais de 2 min com worker recente continua esperando", () => {
    expect(
      queuedRunAbandoned({
        queuedAt: ago(QUEUED_RUN_PATIENCE_MS + 1),
        workerSeenAt: ago(WORKER_GONE_MS),
        now,
      }),
    ).toBe(false);
  });

  it("um run na fila há mais de 2 min sem worker há mais de 90 s está abandonado", () => {
    expect(
      queuedRunAbandoned({
        queuedAt: ago(QUEUED_RUN_PATIENCE_MS + 1),
        workerSeenAt: ago(WORKER_GONE_MS + 1),
        now,
      }),
    ).toBe(true);
    expect(queuedRunAbandoned({ queuedAt: ago(10 * 60_000), workerSeenAt: null, now })).toBe(true);
  });

  it("a mensagem diz o que fazer, não o que quebrou", () => {
    expect(WORKER_DOWN_MESSAGE).toMatch(/Reinicie o Quibt Bot/);
    expect(WORKER_DOWN_MESSAGE).toMatch(/mande de novo/);
  });
});
