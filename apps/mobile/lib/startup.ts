export const LOCAL_STARTUP_TIMEOUT_MS = 4_000;
export const INBOX_STARTUP_TIMEOUT_MS = 8_000;
export const STARTUP_UNAVAILABLE_PARAM = "unavailable";

export type StartupResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "timeout" | "error"; error?: unknown };

export type InboxStartupState = "ready" | "signed-out" | "unavailable";

export function hasUsableStartupSession(result: StartupResult<string>) {
  return result.ok && Boolean(result.value);
}

export function shouldOpenConnectionScreen(result: StartupResult<InboxStartupState>) {
  return !result.ok || result.value === "unavailable";
}

/**
 * A abertura do app nunca pode depender para sempre do Keychain ou da rede. O sinal
 * cancela operações que aceitam AbortController; o `finish` também encerra no prazo
 * as APIs nativas que não aceitam cancelamento, ignorando uma resposta atrasada.
 */
export function runStartupTask<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<StartupResult<T>> {
  const controller = new AbortController();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: StartupResult<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish({ ok: false, reason: "timeout" });
    }, timeoutMs);

    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => finish({ ok: true, value }),
        (error) => finish({ ok: false, reason: "error", error }),
      );
  });
}
