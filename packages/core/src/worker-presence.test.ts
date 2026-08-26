import { describe, expect, it } from "vitest";
import {
  leasedRunAbandoned,
  QUEUED_RUN_PATIENCE_MS,
  queuedRunAbandoned,
  runLooksStranded,
  WORKER_ALIVE_MS,
  WORKER_DOWN_MESSAGE,
  WORKER_GONE_MS,
  WORKER_HEARTBEAT_MS,
  WORKER_SEEN_UNKNOWN,
  workerGone,
  workerMayBeBooting,
  workerPresence,
  workerSeenUnknown,
} from "./worker-presence.js";

const now = new Date("2026-08-25T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("workerPresence", () => {
  it("nunca visto é morto, sem data", () => {
    expect(workerPresence(null, now)).toEqual({ alive: false, lastSeenAt: null });
    expect(workerPresence(undefined, now)).toEqual({ alive: false, lastSeenAt: null });
  });

  it("uma leitura que falhou responde morto, sem data — mas é 'não sei', não 'nunca'", () => {
    expect(workerPresence(WORKER_SEEN_UNKNOWN, now)).toEqual({ alive: false, lastSeenAt: null });
    expect(workerSeenUnknown(WORKER_SEEN_UNKNOWN)).toBe(true);
    expect(workerSeenUnknown(null)).toBe(false);
    expect(workerSeenUnknown(now)).toBe(false);
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

  it("não saber não é sumido: uma leitura que falhou nunca reprova ninguém", () => {
    expect(workerGone(WORKER_SEEN_UNKNOWN, now)).toBe(false);
  });
});

describe("workerMayBeBooting", () => {
  it("a API recém-subida ainda espera o worker vir atrás dela", () => {
    expect(workerMayBeBooting(undefined, now)).toBe(false);
    expect(workerMayBeBooting(ago(WORKER_GONE_MS - 1), now)).toBe(true);
    expect(workerMayBeBooting(ago(WORKER_GONE_MS), now)).toBe(false);
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

  it("com a leitura do batimento em 'não sei', a fila velha fica em paz", () => {
    expect(
      queuedRunAbandoned({ queuedAt: ago(10 * 60_000), workerSeenAt: WORKER_SEEN_UNKNOWN, now }),
    ).toBe(false);
  });

  it("a mensagem diz o que fazer, sem jargão", () => {
    expect(WORKER_DOWN_MESSAGE).toMatch(/Reinicie o Quibt Bot/);
    expect(WORKER_DOWN_MESSAGE).toMatch(/mande a mensagem de novo/);
    expect(WORKER_DOWN_MESSAGE).toMatch(/docker compose restart/);
    expect(WORKER_DOWN_MESSAGE).not.toMatch(/worker/i);
  });
});

describe("leasedRunAbandoned", () => {
  it("um lease vencido há pouco ainda é do reaper do worker", () => {
    expect(
      leasedRunAbandoned({ leaseExpiresAt: ago(WORKER_GONE_MS), workerSeenAt: null, now }),
    ).toBe(false);
  });

  it("um lease vencido há mais de 90 s sem worker há mais de 90 s está abandonado", () => {
    expect(
      leasedRunAbandoned({
        leaseExpiresAt: ago(WORKER_GONE_MS + 1),
        workerSeenAt: ago(WORKER_GONE_MS + 1),
        now,
      }),
    ).toBe(true);
    expect(
      leasedRunAbandoned({ leaseExpiresAt: ago(WORKER_GONE_MS + 1), workerSeenAt: null, now }),
    ).toBe(true);
  });

  it("com worker vivo, ou sem lease, ou sem saber, nada", () => {
    expect(
      leasedRunAbandoned({
        leaseExpiresAt: ago(WORKER_GONE_MS + 1),
        workerSeenAt: ago(WORKER_GONE_MS),
        now,
      }),
    ).toBe(false);
    expect(leasedRunAbandoned({ leaseExpiresAt: null, workerSeenAt: null, now })).toBe(false);
    expect(
      leasedRunAbandoned({
        leaseExpiresAt: ago(WORKER_GONE_MS + 1),
        workerSeenAt: WORKER_SEEN_UNKNOWN,
        now,
      }),
    ).toBe(false);
  });
});

describe("runLooksStranded", () => {
  it("fila velha ou lease vencido há tempo demais; o resto, não", () => {
    expect(
      runLooksStranded({ status: "queued", updatedAt: ago(QUEUED_RUN_PATIENCE_MS + 1) }, now),
    ).toBe(true);
    expect(runLooksStranded({ status: "queued", updatedAt: ago(QUEUED_RUN_PATIENCE_MS) }, now)).toBe(
      false,
    );
    expect(
      runLooksStranded(
        { status: "running", updatedAt: now, leaseExpiresAt: ago(WORKER_GONE_MS + 1) },
        now,
      ),
    ).toBe(true);
    expect(
      runLooksStranded({ status: "leased", updatedAt: now, leaseExpiresAt: ago(WORKER_GONE_MS) }, now),
    ).toBe(false);
    expect(runLooksStranded({ status: "running", updatedAt: ago(3_600_000) }, now)).toBe(false);
    expect(
      runLooksStranded(
        { status: "waiting_input", updatedAt: ago(3_600_000), leaseExpiresAt: ago(3_600_000) },
        now,
      ),
    ).toBe(false);
  });
});
