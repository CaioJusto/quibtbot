import { startPolling } from "./polling.js";

/**
 * Estado que a tela mostra. `connected` só depois que o fluxo abriu de fato;
 * `reconnecting` na primeira falha, e `offline` quando as tentativas já duram o
 * bastante para valer avisar que a máquina do Quibt pode estar desligada.
 */
export type LiveFeedStatus = "connecting" | "connected" | "reconnecting" | "offline";

export type LiveFeedOptions = {
  /**
   * Opens the live stream. Resolves when the stream ends (server closed it, network dropped)
   * and rejects when it could not be opened. Must stop promptly once `signal` aborts.
   * `opened` marks the moment the stream is really up — sem essa chamada o estado
   * nunca passa de "connecting", porque `connect` só resolve quando o fluxo acaba.
   */
  connect: (signal: AbortSignal, opened: () => void) => Promise<void>;
  /** Catches up while the stream is down; runs on a fixed interval until the stream is back. */
  refresh: () => Promise<void>;
  /** Interval between catch-up refreshes while disconnected. Default 2500ms. */
  pollIntervalMs?: number;
  /** First reconnect delay. Doubles per attempt until `maxBackoffMs`. Default 1000ms. */
  minBackoffMs?: number;
  /** Cap for the reconnect delay. Default 15000ms. */
  maxBackoffMs?: number;
  /** A stream that stayed open at least this long resets the backoff. Default 10000ms. */
  healthyAfterMs?: number;
  onError?: (error: unknown) => void;
  /** Chamado a cada mudança de estado, nunca com o mesmo valor duas vezes seguidas. */
  onStatus?: (status: LiveFeedStatus) => void;
  /** Tentativas seguidas sem conseguir abrir antes de virar "offline". Padrão 3. */
  offlineAfterAttempts?: number;
};

export type LiveFeed = {
  /** Aborts the current stream and stops the loop; safe to call more than once. */
  stop: () => void;
  /** Aborts the current stream and stops reconnecting (app went to background). */
  pause: () => void;
  /** Reconnects right away with fresh backoff (app came back to foreground). */
  resume: () => void;
  /** Estado atual, para quem monta a tela depois que o fluxo já começou. */
  status: () => LiveFeedStatus;
};

/**
 * Keeps a server stream alive for the lifetime of a screen. Reconnects with exponential
 * backoff whenever the stream ends or fails, and polls `refresh` while it is down so the
 * UI keeps moving even when streaming is unavailable.
 */
export function startLiveFeed(options: LiveFeedOptions): LiveFeed {
  const pollIntervalMs = options.pollIntervalMs ?? 2_500;
  const minBackoffMs = options.minBackoffMs ?? 1_000;
  const maxBackoffMs = options.maxBackoffMs ?? 15_000;
  const healthyAfterMs = options.healthyAfterMs ?? 10_000;
  const offlineAfterAttempts = options.offlineAfterAttempts ?? 3;

  let stopped = false;
  let status: LiveFeedStatus = "connecting";
  let generation = 0;
  let current: AbortController | undefined;
  let wake: (() => void) | undefined;

  const setStatus = (next: LiveFeedStatus) => {
    if (stopped || next === status) return;
    status = next;
    try {
      options.onStatus?.(next);
    } catch {
      // A tela avisando errado não pode derrubar o fluxo.
    }
  };

  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // Error reporting must never break the loop.
    }
  };

  const wait = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        wake = undefined;
        resolve();
      }
      wake = done;
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });

  const run = async (myGeneration: number) => {
    let attempt = 0;
    while (!stopped && myGeneration === generation) {
      const controller = new AbortController();
      current = controller;
      const openedAt = Date.now();
      try {
        // Só o estado muda aqui: zerar o backoff num fluxo que abre e cai na hora
        // faria a reconexão martelar o servidor. Quem zera é o healthyAfterMs abaixo.
        await options.connect(controller.signal, () => setStatus("connected"));
      } catch (error) {
        if (!controller.signal.aborted) report(error);
      }
      if (stopped || controller.signal.aborted || myGeneration !== generation) return;

      if (Date.now() - openedAt >= healthyAfterMs) attempt = 0;
      setStatus(attempt + 1 >= offlineAfterAttempts ? "offline" : "reconnecting");
      const delay = Math.min(maxBackoffMs, minBackoffMs * 2 ** attempt);
      attempt += 1;

      // Bridge the gap with plain polling so nothing looks frozen while we back off.
      const stopPolling = startPolling(options.refresh, pollIntervalMs, {
        immediate: true,
        onError: report,
      });
      try {
        await wait(delay, controller.signal);
      } finally {
        stopPolling();
      }
    }
  };

  const abortCurrent = () => {
    generation += 1;
    current?.abort();
    current = undefined;
    wake?.();
  };

  void run(generation);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      abortCurrent();
    },
    pause() {
      if (stopped) return;
      abortCurrent();
    },
    resume() {
      if (stopped) return;
      abortCurrent();
      setStatus("connecting");
      void run(generation);
    },
    status() {
      return status;
    },
  };
}
