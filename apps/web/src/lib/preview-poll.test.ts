import { describe, expect, it } from "vitest";
import {
  PREVIEW_POLL_MS,
  PREVIEW_RETRY_MAX_MS,
  previewAgeLabel,
  previewAgeMs,
  previewPollDelayMs,
  shouldPollPreview,
} from "./preview-poll.js";

const NOW = 1_700_000_000_000;

const watching = {
  state: "running",
  controlHolder: "agent",
  shown: true,
  hidden: false,
  streaming: false,
};

describe("shouldPollPreview", () => {
  it("pede retratos quando o bot trabalha, o painel está à vista e ninguém tem o iframe", () => {
    expect(shouldPollPreview(watching)).toBe(true);
    expect(shouldPollPreview({ ...watching, controlHolder: null })).toBe(true);
  });

  it("para quando o computador não está ligado", () => {
    for (const state of ["booting", "suspended", "stopped", "error", null, undefined]) {
      expect(shouldPollPreview({ ...watching, state })).toBe(false);
    }
  });

  it("para com o painel fechado ou a aba escondida", () => {
    expect(shouldPollPreview({ ...watching, shown: false })).toBe(false);
    expect(shouldPollPreview({ ...watching, hidden: true })).toBe(false);
  });

  it("para quando o usuário tem o controle: o iframe noVNC assume", () => {
    expect(shouldPollPreview({ ...watching, controlHolder: "user" })).toBe(false);
  });

  it("para quando já há um stream montado, mesmo sem o controle", () => {
    expect(shouldPollPreview({ ...watching, streaming: true })).toBe(false);
  });
});

describe("previewPollDelayMs", () => {
  it("segue o TTL do cache da API enquanto tudo responde", () => {
    expect(previewPollDelayMs(0)).toBe(PREVIEW_POLL_MS);
    expect(previewPollDelayMs(0)).toBe(3_000);
  });

  it("dobra a cada falha seguida até o teto", () => {
    expect(previewPollDelayMs(1)).toBe(6_000);
    expect(previewPollDelayMs(2)).toBe(12_000);
    expect(previewPollDelayMs(3)).toBe(24_000);
    expect(previewPollDelayMs(4)).toBe(PREVIEW_RETRY_MAX_MS);
    expect(previewPollDelayMs(50)).toBe(PREVIEW_RETRY_MAX_MS);
    expect(previewPollDelayMs(10_000)).toBe(PREVIEW_RETRY_MAX_MS);
  });

  it("trata entrada torta como sem falha", () => {
    expect(previewPollDelayMs(-1)).toBe(PREVIEW_POLL_MS);
    expect(previewPollDelayMs(Number.NaN)).toBe(PREVIEW_POLL_MS);
  });
});

describe("previewAgeMs", () => {
  it("conta do recebimento mais o que o cache já tinha de idade", () => {
    const frame = { capturedAt: new Date(NOW - 1_000).toISOString(), receivedAt: NOW };
    expect(previewAgeMs(frame, NOW)).toBe(1_000);
    expect(previewAgeMs(frame, NOW + 4_000)).toBe(5_000);
  });

  it("limita a parte do servidor ao TTL: relógio divergente não vira minutos", () => {
    const frame = { capturedAt: new Date(NOW - 600_000).toISOString(), receivedAt: NOW };
    expect(previewAgeMs(frame, NOW)).toBe(PREVIEW_POLL_MS);
  });

  it("ignora capturedAt no futuro ou ausente", () => {
    expect(
      previewAgeMs({ capturedAt: new Date(NOW + 90_000).toISOString(), receivedAt: NOW }, NOW),
    ).toBe(0);
    expect(previewAgeMs({ capturedAt: null, receivedAt: NOW }, NOW + 2_500)).toBe(2_500);
    expect(previewAgeMs({ capturedAt: "ontem", receivedAt: NOW }, NOW + 2_500)).toBe(2_500);
  });

  it("nunca é negativo", () => {
    expect(previewAgeMs({ capturedAt: null, receivedAt: NOW + 5_000 }, NOW)).toBe(0);
  });
});

describe("previewAgeLabel", () => {
  it("diz 'agora' no primeiro segundo e 'há Ns' depois", () => {
    expect(previewAgeLabel(0)).toBe("ao vivo · agora");
    expect(previewAgeLabel(999)).toBe("ao vivo · agora");
    expect(previewAgeLabel(1_000)).toBe("ao vivo · há 1s");
    expect(previewAgeLabel(4_400)).toBe("ao vivo · há 4s");
    expect(previewAgeLabel(59_999)).toBe("ao vivo · há 59s");
  });

  it("perde o 'ao vivo' depois de um minuto sem retrato novo", () => {
    expect(previewAgeLabel(60_000)).toBe("há 1min");
    expect(previewAgeLabel(150_000)).toBe("há 2min");
  });
});
