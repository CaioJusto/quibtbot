import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPreviewPoller,
  holdsComputerControl,
  othersHoldControl,
  PREVIEW_POLL_MS,
  PREVIEW_RETRY_MAX_MS,
  PREVIEW_STALE_MS,
  type PreviewFrame,
  type PreviewResponse,
  previewAgeLabel,
  previewAgeMs,
  previewIsStale,
  previewPollDelayMs,
  shouldPollPreview,
} from "./preview-poll.js";

const NOW = 1_700_000_000_000;

const watching = {
  state: "running",
  controlHolder: "bot",
  screenUrl: null,
  shown: true,
  hidden: false,
  streaming: false,
  screenLost: false,
};

describe("holdsComputerControl", () => {
  it("é meu só quando o lease é de usuário e a API me deu a URL da tela", () => {
    expect(holdsComputerControl({ controlHolder: "user", screenUrl: "https://x/embed" })).toBe(
      true,
    );
  });

  it("controlHolder 'user' sem URL é outra pessoa da workspace no controle", () => {
    expect(holdsComputerControl({ controlHolder: "user", screenUrl: null })).toBe(false);
    expect(holdsComputerControl({ controlHolder: "user", screenUrl: "" })).toBe(false);
    expect(holdsComputerControl({ controlHolder: "user", screenUrl: undefined })).toBe(false);
  });

  it("o bot ou ninguém com o controle nunca é meu, mesmo com URL sobrando", () => {
    expect(holdsComputerControl({ controlHolder: "bot", screenUrl: "https://x/embed" })).toBe(
      false,
    );
    expect(holdsComputerControl({ controlHolder: "none", screenUrl: null })).toBe(false);
  });
});

describe("othersHoldControl", () => {
  const running = { state: "running", controlHolder: "user", screenUrl: null };

  it("lease de usuário sem a minha URL, com a tela de pé, é outra pessoa", () => {
    expect(othersHoldControl(running)).toBe(true);
  });

  it("com a minha URL o lease é meu, nunca de outra pessoa", () => {
    expect(othersHoldControl({ ...running, screenUrl: "https://x/embed" })).toBe(false);
  });

  it("bot ou ninguém no controle não é outra pessoa", () => {
    expect(othersHoldControl({ ...running, controlHolder: "bot" })).toBe(false);
    expect(othersHoldControl({ ...running, controlHolder: "none" })).toBe(false);
  });

  it("enquanto o computador liga não acusa ninguém: quem acabou de assumir ainda não tem URL", () => {
    expect(othersHoldControl({ ...running, state: "booting" })).toBe(false);
    expect(othersHoldControl({ ...running, state: "suspended" })).toBe(false);
    expect(othersHoldControl({ ...running, state: null })).toBe(false);
  });
});

describe("shouldPollPreview", () => {
  it("pede retratos quando o bot trabalha, o painel está à vista e ninguém tem o iframe", () => {
    expect(shouldPollPreview(watching)).toBe(true);
    expect(shouldPollPreview({ ...watching, controlHolder: "none" })).toBe(true);
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

  it("para quando o controle é meu: o iframe noVNC assume", () => {
    expect(
      shouldPollPreview({ ...watching, controlHolder: "user", screenUrl: "https://x/embed" }),
    ).toBe(false);
  });

  it("continua quando outra pessoa tem o controle: para mim só há o retrato", () => {
    expect(shouldPollPreview({ ...watching, controlHolder: "user", screenUrl: null })).toBe(true);
  });

  it("para quando já há um stream montado, mesmo sem o controle", () => {
    expect(shouldPollPreview({ ...watching, streaming: true })).toBe(false);
  });

  it("para quando a tela caiu de vez: o painel está avisando, não é hora de retrato", () => {
    expect(shouldPollPreview({ ...watching, screenLost: true })).toBe(false);
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

describe("createPreviewPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  type Step = PreviewResponse | Error | "hold";

  function poller(steps: Step[]) {
    const calls: number[] = [];
    const frames: PreviewFrame[] = [];
    const failures: number[] = [];
    let held: { resolve: (r: PreviewResponse) => void } | null = null;
    const handle = createPreviewPoller({
      fetch: () => {
        calls.push(Date.now());
        const next = steps.shift();
        if (next === "hold" || next === undefined) {
          return new Promise<PreviewResponse>((resolve) => {
            held = { resolve };
          });
        }
        if (next instanceof Error) return Promise.reject(next);
        return Promise.resolve(next);
      },
      setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms) as unknown as number,
      clearTimeout: (id) => globalThis.clearTimeout(id),
      onFrame: (frame) => frames.push(frame),
      onFailure: (count) => failures.push(count),
    });
    return {
      handle,
      calls,
      frames,
      failures,
      /** Libera o pedido "hold" em voo com esta resposta. */
      release: async (response: PreviewResponse) => {
        held?.resolve(response);
        held = null;
        await vi.advanceTimersByTimeAsync(0);
      },
    };
  }

  const frame = (image: string): PreviewResponse => ({
    image,
    capturedAt: new Date(NOW).toISOString(),
  });

  it("pede um retrato já na largada e o próximo depois do TTL", async () => {
    const p = poller([frame("a"), frame("b")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(p.frames.map((f) => f.image)).toEqual(["a"]);
    expect(p.frames[0]?.receivedAt).toBe(NOW);
    await vi.advanceTimersByTimeAsync(PREVIEW_POLL_MS - 1);
    expect(p.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(p.calls).toHaveLength(2);
    expect(p.frames.map((f) => f.image)).toEqual(["a", "b"]);
    p.handle.stop();
  });

  it("image: null conta como falha, dobra a espera e não entrega retrato nenhum", async () => {
    const p = poller([frame("a"), { image: null, capturedAt: null }, frame("c")]);
    await vi.advanceTimersByTimeAsync(PREVIEW_POLL_MS);
    expect(p.failures).toEqual([1]);
    // O retrato "a" continua sendo o último entregue: nada foi apagado.
    expect(p.frames.map((f) => f.image)).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(PREVIEW_POLL_MS);
    expect(p.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(PREVIEW_POLL_MS);
    expect(p.calls).toHaveLength(3);
    expect(p.frames.map((f) => f.image)).toEqual(["a", "c"]);
    p.handle.stop();
  });

  it("um erro conta como falha seguida e o sucesso zera o backoff", async () => {
    const p = poller([new Error("timeout"), new Error("timeout"), frame("ok"), frame("ok2")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(p.failures).toEqual([1]);
    await vi.advanceTimersByTimeAsync(previewPollDelayMs(1));
    expect(p.failures).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(previewPollDelayMs(2));
    expect(p.frames.map((f) => f.image)).toEqual(["ok"]);
    // Depois do sucesso volta ao TTL, não ao dobro de 12 s.
    await vi.advanceTimersByTimeAsync(PREVIEW_POLL_MS);
    expect(p.frames.map((f) => f.image)).toEqual(["ok", "ok2"]);
    p.handle.stop();
  });

  it("stop() cancela o timer agendado", async () => {
    const p = poller([frame("a"), frame("b")]);
    await vi.advanceTimersByTimeAsync(0);
    p.handle.stop();
    await vi.advanceTimersByTimeAsync(PREVIEW_RETRY_MAX_MS * 2);
    expect(p.calls).toHaveLength(1);
  });

  it("stop() durante um pedido em voo descarta a resposta e não agenda tick novo", async () => {
    const p = poller(["hold"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(p.calls).toHaveLength(1);
    p.handle.stop();
    await p.release(frame("a"));
    expect(p.frames).toEqual([]);
    expect(p.failures).toEqual([]);
    await vi.advanceTimersByTimeAsync(PREVIEW_RETRY_MAX_MS * 2);
    expect(p.calls).toHaveLength(1);
  });

  it("nunca tem dois pedidos ao mesmo tempo: o próximo só sai depois da resposta", async () => {
    const p = poller(["hold", frame("b")]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PREVIEW_RETRY_MAX_MS);
    expect(p.calls).toHaveLength(1);
    await p.release(frame("a"));
    expect(p.frames.map((f) => f.image)).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(PREVIEW_POLL_MS);
    expect(p.calls).toHaveLength(2);
    p.handle.stop();
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

describe("previewIsStale", () => {
  it("um retrato velho de até um minuto ainda fica na tela, envelhecendo no selo", () => {
    expect(previewIsStale(0)).toBe(false);
    expect(previewIsStale(45_000)).toBe(false);
    expect(previewIsStale(PREVIEW_STALE_MS)).toBe(false);
  });

  it("passado o minuto ele some e volta a ilustração", () => {
    expect(previewIsStale(PREVIEW_STALE_MS + 1)).toBe(true);
    expect(previewIsStale(300_000)).toBe(true);
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
