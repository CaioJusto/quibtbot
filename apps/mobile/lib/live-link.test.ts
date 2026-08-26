import type { LiveFeedStatus } from "@quibt/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTION_PROBLEM_MESSAGE,
  connectionChipLabel,
  createSafetyPoller,
  isConnectionProblem,
  QUIET_RUN_MS,
  SAFETY_POLL_TICK_MS,
  shouldSafetyPoll,
  userFacingError,
} from "./live-link";

describe("shouldSafetyPoll", () => {
  const now = 100_000;

  it("não polla com o fio saudável, com ou sem run, enquanto os eventos chegam", () => {
    expect(
      shouldSafetyPoll({ status: "connected", working: true, lastEventAt: now - 1_000, now }),
    ).toBe(false);
    expect(
      shouldSafetyPoll({ status: "connected", working: false, lastEventAt: now - 60_000, now }),
    ).toBe(false);
    expect(
      shouldSafetyPoll({ status: "connecting", working: false, lastEventAt: now - 60_000, now }),
    ).toBe(false);
  });

  it("polla quando o bot trabalha e o fio ficou mudo por mais de 8 s (proxy segurando o SSE)", () => {
    expect(
      shouldSafetyPoll({
        status: "connected",
        working: true,
        lastEventAt: now - QUIET_RUN_MS + 1,
        now,
      }),
    ).toBe(false);
    expect(
      shouldSafetyPoll({
        status: "connected",
        working: true,
        lastEventAt: now - QUIET_RUN_MS,
        now,
      }),
    ).toBe(true);
    // Também durante o "connecting" inicial que pendura: o run está de pé e nada chega.
    expect(
      shouldSafetyPoll({ status: "connecting", working: true, lastEventAt: now - 20_000, now }),
    ).toBe(true);
  });

  it("polla sempre que o fio caiu, mesmo sem run", () => {
    expect(
      shouldSafetyPoll({ status: "reconnecting", working: false, lastEventAt: now, now }),
    ).toBe(true);
    expect(shouldSafetyPoll({ status: "offline", working: false, lastEventAt: now, now })).toBe(
      true,
    );
  });

  it("insiste enquanto um poll falhado deixou o chip 'Reconectando…' na tela", () => {
    // Fio de pé, bot parado: nada mais chamaria o reload, e o aviso ficava preso para sempre.
    expect(
      shouldSafetyPoll({
        status: "connected",
        working: false,
        lastEventAt: now,
        now,
        pollFailed: true,
      }),
    ).toBe(true);
    expect(
      shouldSafetyPoll({
        status: "connected",
        working: false,
        lastEventAt: now,
        now,
        pollFailed: false,
      }),
    ).toBe(false);
  });

  it("aceita um silêncio sob medida", () => {
    expect(
      shouldSafetyPoll({
        status: "connected",
        working: true,
        lastEventAt: now - 3_000,
        now,
        quietMs: 2_000,
      }),
    ).toBe(true);
  });
});

describe("createSafetyPoller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function poller(overrides: {
    status?: LiveFeedStatus;
    working?: boolean;
    lastEventAt?: number;
    pollFailed?: boolean;
    paused?: boolean;
  }) {
    const state = {
      status: overrides.status ?? ("connected" as LiveFeedStatus),
      working: overrides.working ?? false,
      lastEventAt: overrides.lastEventAt ?? Date.now(),
      pollFailed: overrides.pollFailed ?? false,
      paused: overrides.paused ?? false,
    };
    const reload = vi.fn();
    const stop = createSafetyPoller({
      status: () => state.status,
      working: () => state.working,
      lastEventAt: () => state.lastEventAt,
      pollFailed: () => state.pollFailed,
      paused: () => state.paused,
      reload,
    });
    return { state, reload, stop };
  }

  it("fica quieto com o fio de pé e o bot parado", () => {
    vi.useFakeTimers();
    const { reload, stop } = poller({ status: "connected", working: false });
    vi.advanceTimersByTime(10 * SAFETY_POLL_TICK_MS);
    expect(reload).not.toHaveBeenCalled();
    stop();
  });

  it("busca o retrato enquanto o fio está caído e para quando é mandado parar", () => {
    vi.useFakeTimers();
    const { state, reload, stop } = poller({ status: "reconnecting" });
    vi.advanceTimersByTime(SAFETY_POLL_TICK_MS);
    expect(reload).toHaveBeenCalledTimes(1);
    state.status = "connected";
    vi.advanceTimersByTime(3 * SAFETY_POLL_TICK_MS);
    expect(reload).toHaveBeenCalledTimes(1);
    state.status = "offline";
    vi.advanceTimersByTime(SAFETY_POLL_TICK_MS);
    expect(reload).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(10 * SAFETY_POLL_TICK_MS);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("num run mudo entra em cena, e cada evento que chega zera o silêncio", () => {
    vi.useFakeTimers();
    const { state, reload, stop } = poller({ working: true, lastEventAt: Date.now() });
    vi.advanceTimersByTime(QUIET_RUN_MS - SAFETY_POLL_TICK_MS);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SAFETY_POLL_TICK_MS);
    expect(reload).toHaveBeenCalledTimes(1);
    // Chegou um `thread.progress`: o fio está entregando, o poll sai de cena.
    state.lastEventAt = Date.now();
    reload.mockClear();
    vi.advanceTimersByTime(QUIET_RUN_MS - SAFETY_POLL_TICK_MS);
    expect(reload).not.toHaveBeenCalled();
    stop();
  });

  it("não polla com o app no fundo, mesmo com o fio caído", () => {
    vi.useFakeTimers();
    const { reload, stop } = poller({ status: "offline", paused: true });
    vi.advanceTimersByTime(5 * SAFETY_POLL_TICK_MS);
    expect(reload).not.toHaveBeenCalled();
    stop();
  });
});

describe("isConnectionProblem", () => {
  it("reconhece as falhas do fetch, as traduzidas pelo apiFetch e os 5xx do proxy", () => {
    expect(isConnectionProblem("Network request failed")).toBe(true);
    expect(isConnectionProblem("TypeError: Failed to fetch")).toBe(true);
    expect(isConnectionProblem("A conexão demorou demais. Verifique sua internet.")).toBe(true);
    expect(isConnectionProblem("HTTP 502")).toBe(true);
    expect(isConnectionProblem("connect ECONNREFUSED 127.0.0.1:3100")).toBe(true);
    expect(isConnectionProblem("Limite do plano atingido")).toBe(false);
    expect(isConnectionProblem(null)).toBe(false);
    expect(isConnectionProblem("")).toBe(false);
  });
});

describe("userFacingError", () => {
  it("troca a rede caída por uma frase nossa e deixa o resto passar", () => {
    expect(userFacingError(new Error("Network request failed"), "Não foi possível enviar")).toBe(
      CONNECTION_PROBLEM_MESSAGE,
    );
    expect(userFacingError(new Error("HTTP 503"), "Não foi possível enviar")).toBe(
      CONNECTION_PROBLEM_MESSAGE,
    );
    expect(userFacingError(new Error("Esse bot não existe mais"), "x")).toBe(
      "Esse bot não existe mais",
    );
    expect(userFacingError("string solta", "Não foi possível enviar")).toBe(
      "Não foi possível enviar",
    );
    expect(userFacingError(new Error(""), "Não foi possível enviar")).toBe(
      "Não foi possível enviar",
    );
    expect(userFacingError(new Error("Output validation failed"), "x")).toBe(
      "A conversa está sincronizando. Tentando novamente…",
    );
  });
});

describe("connectionChipLabel", () => {
  it("some com o fio de pé, avisa 'reconectando' na queda e 'sem contato' quando desistiu", () => {
    expect(connectionChipLabel({ status: "connected", pollFailed: false })).toBeNull();
    expect(connectionChipLabel({ status: "connecting", pollFailed: false })).toBeNull();
    expect(connectionChipLabel({ status: "reconnecting", pollFailed: false })).toBe(
      "Reconectando…",
    );
    expect(connectionChipLabel({ status: "offline", pollFailed: false })).toBe(
      "Sem contato com o seu Quibt",
    );
    // Um poll que falhou por rede, com o fio ainda "de pé", é só reconectando.
    expect(connectionChipLabel({ status: "connected", pollFailed: true })).toBe("Reconectando…");
    expect(connectionChipLabel({ status: "offline", pollFailed: true })).toBe(
      "Sem contato com o seu Quibt",
    );
  });

  it("segura o aviso enquanto a reconexão é só um socket mudo voltando", () => {
    // Proxy que bufferiza o SSE: o vigia derruba o socket a cada ~16 s e a volta leva ~1 s.
    expect(
      connectionChipLabel({
        status: "reconnecting",
        pollFailed: false,
        reconnectingSettled: false,
      }),
    ).toBeNull();
    // Passados os 3 s, é queda de verdade e vale avisar.
    expect(
      connectionChipLabel({ status: "reconnecting", pollFailed: false, reconnectingSettled: true }),
    ).toBe("Reconectando…");
    // "Sem contato" não espera nada: o feed já desistiu algumas vezes.
    expect(
      connectionChipLabel({ status: "offline", pollFailed: false, reconnectingSettled: false }),
    ).toBe("Sem contato com o seu Quibt");
  });
});
