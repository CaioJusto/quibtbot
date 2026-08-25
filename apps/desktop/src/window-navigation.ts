export const NAVIGATION_TIMEOUT_MS = 15_000;

export interface NavigationContents {
  once(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}

export function waitForWebContentsLoad(
  contents: NavigationContents,
  isCurrentNavigation: () => boolean,
  load: () => Promise<void>,
  timeoutMs = NAVIGATION_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const settle = (outcome: "resolve" | "reject", error?: Error) => {
      if (settled) return;
      if (!isCurrentNavigation()) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error("Navegação cancelada."));
        return;
      }
      settled = true;
      clearTimeout(timer);
      cleanup();
      if (outcome === "resolve") resolve();
      else reject(error ?? new Error("Falha ao carregar a página."));
    };

    const onFinish = () => settle("resolve");

    const onFail = (...args: unknown[]) => {
      if (args.length < 5) return;
      const errorCode = args[1] as number;
      const validatedURL = args[3] as string;
      const isMainFrame = args[4] as boolean;
      if (isMainFrame !== true) return;
      settle("reject", new Error(`Falha ao carregar ${validatedURL} (${errorCode})`));
    };

    const cleanup = () => {
      contents.removeListener("did-finish-load", onFinish);
      contents.removeListener("did-fail-load", onFail);
    };

    const timer = setTimeout(() => {
      settle("reject", new Error("A URL não respondeu dentro do tempo limite."));
    }, timeoutMs);

    contents.once("did-finish-load", onFinish);
    contents.once("did-fail-load", onFail);

    void load().catch((error: unknown) => {
      settle("reject", error instanceof Error ? error : new Error("Falha ao iniciar a navegação."));
    });
  });
}
