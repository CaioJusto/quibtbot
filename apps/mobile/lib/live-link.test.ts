import { describe, expect, it } from "vitest";
import {
  CONNECTION_PROBLEM_MESSAGE,
  connectionChipLabel,
  isConnectionProblem,
  QUIET_RUN_MS,
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
});
