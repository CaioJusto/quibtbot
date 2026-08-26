import { describe, expect, it } from "vitest";
import {
  CONTROL_LEASE_MS,
  CONTROL_LEASE_RENEW_GAP_MS,
  type ControlLeaseSnapshot,
  canTakeControl,
  checkControlLease,
  controlLeaseHasFreshInput,
  controlLeaseLive,
  controlLeaseWantsRenewal,
  controlUntilLabel,
  grantControlLease,
  newControlLeaseId,
  reapExpiredControlLeases,
  releaseControlLease,
  renewControlLease,
  touchControlLease,
  withControlLease,
} from "./control-lease.js";

const now = new Date("2026-08-14T12:00:00Z");
const later = new Date(now.getTime() + CONTROL_LEASE_MS + 1);

function session(overrides: Partial<ControlLeaseSnapshot> = {}): ControlLeaseSnapshot {
  return {
    controlHolder: "user",
    controlLeaseId: "ctl_live",
    controlLeaseUserId: "user-1",
    controlLeaseExpiresAt: new Date(now.getTime() + CONTROL_LEASE_MS),
    controlFence: 3,
    ...overrides,
  };
}

/** Single-row stand-in for `desktop_sessions`, enforcing the fence guard the real query uses. */
function fakeDb(row: ControlLeaseSnapshot & { botId: string; state?: string }) {
  const state = { row };
  const matches = (where: Record<string, unknown>) => {
    if (where.botId && where.botId !== state.row.botId) return false;
    if (where.controlFence !== undefined && where.controlFence !== state.row.controlFence) {
      return false;
    }
    if (where.controlHolder && where.controlHolder !== state.row.controlHolder) return false;
    if (where.controlLeaseId !== undefined && where.controlLeaseId !== state.row.controlLeaseId) {
      return false;
    }
    if (
      where.controlLeaseUserId !== undefined &&
      where.controlLeaseUserId !== state.row.controlLeaseUserId
    ) {
      return false;
    }
    const stateFilter = where.state as { not?: string } | undefined;
    if (stateFilter?.not && "state" in state.row && state.row.state === stateFilter.not) {
      return false;
    }
    return true;
  };
  const db = {
    desktopSession: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        if (state.row.controlHolder !== where.controlHolder) return [];
        const expiry = state.row.controlLeaseExpiresAt;
        const cutoff = (where.OR as Array<{ controlLeaseExpiresAt: { lt: Date } | null }>)[0]
          ?.controlLeaseExpiresAt as { lt: Date };
        const expired = !expiry || expiry.getTime() < cutoff.lt.getTime();
        if (!expired) return [];
        return [{ botId: state.row.botId, controlFence: state.row.controlFence }];
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (!matches(where)) return { count: 0 };
        state.row = { ...state.row, ...(data as Partial<typeof state.row>) };
        return { count: 1 };
      },
    },
  };
  return { db, state };
}

describe("newControlLeaseId", () => {
  it("is not the bot id in a costume", () => {
    const first = newControlLeaseId();
    expect(first).not.toBe(newControlLeaseId());
    expect(first).not.toMatch(/^lease-/);
    expect(first.length).toBeGreaterThan(20);
  });
});

describe("controlLeaseLive", () => {
  it("expires on its own deadline and treats a deadline-less lease as dead", () => {
    expect(controlLeaseLive(session(), now)).toBe(true);
    expect(controlLeaseLive(session(), later)).toBe(false);
    expect(controlLeaseLive(session({ controlLeaseExpiresAt: null }), now)).toBe(false);
    expect(controlLeaseLive(session({ controlHolder: "bot" }), now)).toBe(false);
  });
});

describe("checkControlLease", () => {
  it("accepts the holder and reports the fence to send to the sandbox", () => {
    expect(checkControlLease(session(), { userId: "user-1", leaseId: "ctl_live" }, now)).toEqual({
      ok: true,
      fence: 3,
      leaseId: "ctl_live",
    });
  });

  it("refuses a stale lease id, an expired lease, and another member", () => {
    expect(checkControlLease(session(), { userId: "user-1", leaseId: "ctl_old" }, now)).toEqual({
      ok: false,
      reason: "wrong_lease",
    });
    expect(checkControlLease(session(), { userId: "user-1" }, later)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(checkControlLease(session(), { userId: "user-2" }, now)).toEqual({
      ok: false,
      reason: "other_holder",
    });
    expect(checkControlLease(session({ controlHolder: "bot" }), { userId: "user-1" }, now)).toEqual(
      { ok: false, reason: "bot_in_control" },
    );
  });
});

describe("canTakeControl", () => {
  it("lets the holder renew, blocks a second member, and frees an expired lease", () => {
    expect(canTakeControl(session(), "user-1", now)).toEqual({ ok: true, renew: true });
    expect(canTakeControl(session(), "user-2", now)).toEqual({ ok: false, holderUserId: "user-1" });
    expect(canTakeControl(session(), "user-2", later)).toEqual({ ok: true, renew: false });
  });
});

describe("grantControlLease", () => {
  it("moves the fence forward and persists the deadline", async () => {
    const { db, state } = fakeDb({ ...session({ controlHolder: "bot" }), botId: "bot-1" });
    const granted = await grantControlLease(db, {
      botId: "bot-1",
      userId: "user-9",
      fence: 3,
      now,
    });
    expect(granted).toMatchObject({
      fence: 4,
      expiresAt: new Date(now.getTime() + CONTROL_LEASE_MS),
    });
    expect(state.row.controlLeaseUserId).toBe("user-9");
    expect(state.row.controlLeaseExpiresAt).toEqual(new Date(now.getTime() + CONTROL_LEASE_MS));
    expect(state.row.controlFence).toBe(4);
  });

  it("loses the race instead of overwriting a newer lease", async () => {
    const { db } = fakeDb({ ...session(), botId: "bot-1" });
    expect(
      await grantControlLease(db, { botId: "bot-1", userId: "user-2", fence: 2, now }),
    ).toBeNull();
  });

  it("refuses grant while the session is deleting", async () => {
    const { db } = fakeDb({
      ...session({ controlHolder: "bot" }),
      botId: "bot-1",
      state: "deleting",
    });
    expect(
      await grantControlLease(db, { botId: "bot-1", userId: "user-9", fence: 0, now }),
    ).toBeNull();
  });
});

describe("reapExpiredControlLeases", () => {
  it("gives the computer back to the bot once the deadline passes", async () => {
    const { db, state } = fakeDb({ ...session(), botId: "bot-1" });
    expect(await reapExpiredControlLeases(db, { now })).toEqual([]);
    expect(await reapExpiredControlLeases(db, { now: later })).toEqual(["bot-1"]);
    expect(state.row.controlHolder).toBe("bot");
    expect(state.row.controlLeaseId).toBeNull();
    expect(state.row.controlLeaseUserId).toBeNull();
  });

  it("frees the legacy rows that never had a deadline", async () => {
    const { db, state } = fakeDb({
      ...session({ controlLeaseExpiresAt: null }),
      botId: "bot-1",
    });
    expect(await reapExpiredControlLeases(db, { now })).toEqual(["bot-1"]);
    expect(state.row.controlHolder).toBe("bot");
  });
});

describe("controlLeaseWantsRenewal", () => {
  it("só pede renovação depois de consumir a folga, e nunca para um lease morto", () => {
    // Acabou de ser concedido: renovar agora seria uma escrita por tecla.
    expect(controlLeaseWantsRenewal(session(), now)).toBe(false);
    const almostGap = new Date(now.getTime() + CONTROL_LEASE_RENEW_GAP_MS - 1);
    expect(controlLeaseWantsRenewal(session(), almostGap)).toBe(false);
    const pastGap = new Date(now.getTime() + CONTROL_LEASE_RENEW_GAP_MS);
    expect(controlLeaseWantsRenewal(session(), pastGap)).toBe(true);
    // Faltando um minuto para vencer, com certeza.
    const nearEnd = new Date(now.getTime() + CONTROL_LEASE_MS - 60_000);
    expect(controlLeaseWantsRenewal(session(), nearEnd)).toBe(true);
    // Vencido ou sem prazo não se renova: o caminho é o takeover de novo.
    expect(controlLeaseWantsRenewal(session(), later)).toBe(false);
    expect(controlLeaseWantsRenewal(session({ controlLeaseExpiresAt: null }), pastGap)).toBe(false);
    expect(controlLeaseWantsRenewal(session({ controlHolder: "bot" }), pastGap)).toBe(false);
  });
});

describe("controlLeaseHasFreshInput", () => {
  it("só conta a tecla que veio depois do prazo atual ser escrito", () => {
    const grantedAt = now;
    // Nunca ninguém teclou: o heartbeat de uma aba aberta não pode passar por uso.
    expect(controlLeaseHasFreshInput(session())).toBe(false);
    expect(
      controlLeaseHasFreshInput(session({ controlLastInputAt: new Date(grantedAt.getTime()) })),
    ).toBe(false);
    // Uso de antes da última renovação também não vale de novo.
    expect(
      controlLeaseHasFreshInput(
        session({ controlLastInputAt: new Date(grantedAt.getTime() - 1_000) }),
      ),
    ).toBe(false);
    expect(
      controlLeaseHasFreshInput(session({ controlLastInputAt: new Date(grantedAt.getTime() + 1) })),
    ).toBe(true);
    expect(
      controlLeaseHasFreshInput(
        session({ controlLeaseExpiresAt: null, controlLastInputAt: new Date() }),
      ),
    ).toBe(false);
  });
});

describe("renewControlLease", () => {
  it("empurra o prazo do dono sem mexer no fence nem no id", async () => {
    const { db, state } = fakeDb({ ...session(), botId: "bot-1" });
    const at = new Date(now.getTime() + 5 * 60_000);
    const renewed = await renewControlLease(db, {
      botId: "bot-1",
      leaseId: "ctl_live",
      userId: "user-1",
      now: at,
    });
    expect(renewed).toEqual({ expiresAt: new Date(at.getTime() + CONTROL_LEASE_MS) });
    expect(state.row.controlLeaseExpiresAt).toEqual(new Date(at.getTime() + CONTROL_LEASE_MS));
    expect(state.row.controlFence).toBe(3);
    expect(state.row.controlLeaseId).toBe("ctl_live");
  });

  it("não renova um lease que já é de outra pessoa nem um id que não é mais o atual", async () => {
    const { db, state } = fakeDb({ ...session(), botId: "bot-1" });
    const before = state.row.controlLeaseExpiresAt;
    expect(
      await renewControlLease(db, { botId: "bot-1", leaseId: "ctl_live", userId: "user-2", now }),
    ).toBeNull();
    expect(
      await renewControlLease(db, { botId: "bot-1", leaseId: "ctl_old", userId: "user-1", now }),
    ).toBeNull();
    const { db: botDb } = fakeDb({ ...session({ controlHolder: "bot" }), botId: "bot-1" });
    expect(
      await renewControlLease(botDb, {
        botId: "bot-1",
        leaseId: "ctl_live",
        userId: "user-1",
        now,
      }),
    ).toBeNull();
    expect(state.row.controlLeaseExpiresAt).toEqual(before);
  });
});

describe("touchControlLease", () => {
  it("renova o dono depois da folga e reagenda o reap para o prazo novo", async () => {
    const { db, state } = fakeDb({ ...session(), botId: "bot-1" });
    const jobs: Array<{ name: string; runAt?: Date; jobKey?: string }> = [];
    const wakeup = {
      enqueue: async (job: { name: string; runAt?: Date; jobKey?: string }) => {
        jobs.push(job);
      },
    } as never;
    // Acabou de assumir: nada a fazer, nem escrita nem job.
    expect(
      await touchControlLease({ db, wakeup }, state.row, { botId: "bot-1", userId: "user-1", now }),
    ).toBeNull();
    expect(jobs).toEqual([]);
    const at = new Date(now.getTime() + CONTROL_LEASE_RENEW_GAP_MS);
    const renewed = await touchControlLease({ db, wakeup }, state.row, {
      botId: "bot-1",
      userId: "user-1",
      now: at,
    });
    expect(renewed?.expiresAt).toEqual(new Date(at.getTime() + CONTROL_LEASE_MS));
    expect(state.row.controlLeaseExpiresAt).toEqual(renewed?.expiresAt);
    expect(jobs).toEqual([
      {
        name: "control.reap",
        payload: { botId: "bot-1" },
        runAt: renewed?.expiresAt,
        jobKey: "control.reap:bot-1",
      },
    ]);
  });

  it("o heartbeat de uma tela esquecida não segura o teclado: sem tecla, sem renovação", async () => {
    const { db, state } = fakeDb({ ...session(), botId: "bot-1" });
    const jobs: Array<{ name: string }> = [];
    const wakeup = {
      enqueue: async (job: { name: string }) => {
        jobs.push(job);
      },
    } as never;
    const before = state.row.controlLeaseExpiresAt;
    // Uma hora de aba aberta batendo a cada minuto: o prazo não anda um segundo.
    for (let minute = 1; minute <= 60; minute += 1) {
      const at = new Date(now.getTime() + minute * 60_000);
      expect(
        await touchControlLease({ db, wakeup }, state.row, {
          botId: "bot-1",
          userId: "user-1",
          now: at,
          use: "heartbeat",
        }),
      ).toBeNull();
    }
    expect(state.row.controlLeaseExpiresAt).toEqual(before);
    expect(jobs).toEqual([]);
  });

  it("quem está com o teclado dentro da tela do bot renova sem passar por computer.input", async () => {
    // O noVNC manda as teclas pelo próprio WebSocket: o servidor nunca as vê. Sem esta
    // prova, quem passa 20 minutos num formulário dentro da tela perdia o controle no meio.
    const { db, state } = fakeDb({ ...session(), botId: "bot-1" });
    const at = new Date(now.getTime() + CONTROL_LEASE_RENEW_GAP_MS);
    expect(
      await touchControlLease({ db }, state.row, {
        botId: "bot-1",
        userId: "user-1",
        now: at,
        use: "heartbeat",
      }),
    ).toBeNull();
    const renewed = await touchControlLease({ db }, state.row, {
      botId: "bot-1",
      userId: "user-1",
      now: at,
      use: "heartbeat",
      atScreen: true,
    });
    expect(renewed?.expiresAt).toEqual(new Date(at.getTime() + CONTROL_LEASE_MS));
    // A afirmação vale só para esta batida: não vira bilhete de uso guardado.
    expect(state.row.controlLastInputAt ?? null).toBeNull();
  });

  it("uma tecla dentro da folga vira o bilhete que o heartbeat seguinte lê", async () => {
    const { db, state } = fakeDb({ ...session(), botId: "bot-1" });
    const jobs: Array<{ name: string; runAt?: Date }> = [];
    const wakeup = {
      enqueue: async (job: { name: string; runAt?: Date }) => {
        jobs.push(job);
      },
    } as never;
    const typedAt = new Date(now.getTime() + 5_000);
    // Cedo demais para renovar, mas a pessoa está ali: fica registrado.
    expect(
      await touchControlLease({ db, wakeup }, state.row, {
        botId: "bot-1",
        userId: "user-1",
        now: typedAt,
        use: "input",
      }),
    ).toBeNull();
    expect(state.row.controlLastInputAt).toEqual(typedAt);
    expect(jobs).toEqual([]);
    const beat = new Date(now.getTime() + CONTROL_LEASE_RENEW_GAP_MS);
    const renewed = await touchControlLease({ db, wakeup }, state.row, {
      botId: "bot-1",
      userId: "user-1",
      now: beat,
      use: "heartbeat",
    });
    expect(renewed?.expiresAt).toEqual(new Date(beat.getTime() + CONTROL_LEASE_MS));
    expect(jobs.map((job) => job.name)).toEqual(["control.reap"]);
    // E o bilhete não vale duas vezes: a batida seguinte já não renova nada.
    const nextBeat = new Date(beat.getTime() + CONTROL_LEASE_RENEW_GAP_MS);
    expect(
      await touchControlLease({ db, wakeup }, state.row, {
        botId: "bot-1",
        userId: "user-1",
        now: nextBeat,
        use: "heartbeat",
      }),
    ).toBeNull();
    expect(state.row.controlLeaseExpiresAt).toEqual(renewed?.expiresAt);
  });

  it("a tecla que renova grava o uso junto, numa escrita só", async () => {
    const { db, state } = fakeDb({ ...session(), botId: "bot-1" });
    const at = new Date(now.getTime() + CONTROL_LEASE_RENEW_GAP_MS);
    const renewed = await touchControlLease({ db }, state.row, {
      botId: "bot-1",
      userId: "user-1",
      now: at,
      use: "input",
    });
    expect(renewed?.expiresAt).toEqual(new Date(at.getTime() + CONTROL_LEASE_MS));
    expect(state.row.controlLastInputAt).toEqual(at);
    // O uso que renovou não renova de novo pelo heartbeat: a janela nova já é dele.
    expect(controlLeaseHasFreshInput(state.row)).toBe(false);
  });

  it("ignora quem não é o dono", async () => {
    const { db, state } = fakeDb({ ...session(), botId: "bot-1" });
    const at = new Date(now.getTime() + CONTROL_LEASE_RENEW_GAP_MS);
    const before = state.row.controlLeaseExpiresAt;
    expect(
      await touchControlLease({ db }, state.row, { botId: "bot-1", userId: "user-2", now: at }),
    ).toBeNull();
    expect(state.row.controlLeaseExpiresAt).toEqual(before);
  });
});

describe("controlUntilLabel", () => {
  it("escreve a hora local do prazo e some quando não há prazo ou ele já passou", () => {
    const deadline = new Date(2026, 7, 14, 9, 5); // 09:05 no fuso do aparelho
    const before = new Date(2026, 7, 14, 8, 50);
    expect(controlUntilLabel(deadline, before)).toBe("até 09:05");
    expect(controlUntilLabel(deadline.toISOString(), before)).toBe("até 09:05");
    expect(controlUntilLabel(deadline, new Date(2026, 7, 14, 9, 5))).toBeNull();
    expect(controlUntilLabel(null, before)).toBeNull();
    expect(controlUntilLabel(undefined, before)).toBeNull();
    expect(controlUntilLabel("não é data", before)).toBeNull();
  });
});

describe("withControlLease", () => {
  const status = {
    controlHolder: "user",
    controlLeaseExpiresAt: "2026-08-14T12:15:00.000Z",
    state: "running",
  };

  it("escreve o prazo novo que a batida devolveu e deixa o resto do status intacto", () => {
    const next = withControlLease(status, "2026-08-14T12:30:00.000Z");
    expect(next).toEqual({ ...status, controlLeaseExpiresAt: "2026-08-14T12:30:00.000Z" });
  });

  it("não mexe em nada quando a batida não renovou, ou quando o bot já está no controle", () => {
    expect(withControlLease(status, null)).toBe(status);
    expect(withControlLease(status, undefined)).toBe(status);
    expect(withControlLease(status, status.controlLeaseExpiresAt)).toBe(status);
    const bot = { ...status, controlHolder: "bot" };
    expect(withControlLease(bot, "2026-08-14T12:30:00.000Z")).toBe(bot);
    expect(withControlLease(null, "2026-08-14T12:30:00.000Z")).toBeNull();
  });
});

describe("releaseControlLease", () => {
  it("only releases the lease it was told about", async () => {
    const { db, state } = fakeDb({ ...session(), botId: "bot-1" });
    expect(await releaseControlLease(db, { botId: "bot-1", fence: 2 })).toBe(false);
    expect(state.row.controlHolder).toBe("user");
    expect(await releaseControlLease(db, { botId: "bot-1", fence: 3 })).toBe(true);
    expect(state.row.controlHolder).toBe("bot");
  });
});
