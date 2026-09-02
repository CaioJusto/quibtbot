import { useEffect, useRef, useState } from "react";
import { desktopBotBrowser, normalizeTypedBrowserUrl } from "../lib/bot-browser";

export function BotBrowserPane({
  botId,
  botName,
  visible,
  waiting,
}: {
  botId: string;
  botName: string;
  visible: boolean;
  waiting?: boolean;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [typed, setTyped] = useState("");
  const [url, setUrl] = useState("about:blank");
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const browser = desktopBotBrowser();

  useEffect(() => {
    if (!browser || !visible) return;
    const mount = mountRef.current;
    if (!mount) return;

    const syncBounds = () => {
      const rect = mount.getBoundingClientRect();
      void browser.attach({
        botId,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
    };
    syncBounds();
    const observer = new ResizeObserver(syncBounds);
    observer.observe(mount);
    window.addEventListener("resize", syncBounds);
    const off = browser.onNavigated?.((state) => {
      if (state.botId !== botId) return;
      setUrl(state.url);
      setTyped(state.url === "about:blank" ? "" : state.url);
      setCanGoBack(state.canGoBack);
      setCanGoForward(state.canGoForward);
    });
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
      off?.();
      void browser.hide({ botId });
    };
  }, [browser, botId, visible]);

  if (!visible || !browser) return null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--qb-rail)]">
      <form
        className="flex shrink-0 items-center gap-2 border-b border-[var(--qb-hairline)] bg-[var(--qb-canvas)] px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          const next = normalizeTypedBrowserUrl(typed);
          if (!next) return;
          void browser.loadUrl({ botId, url: next });
        }}
      >
        <button
          type="button"
          className="grid h-8 w-8 place-items-center rounded-full text-[var(--qb-muted)] hover:bg-[var(--qb-surface-2)] hover:text-[var(--qb-ink)] disabled:opacity-40"
          aria-label="Voltar"
          disabled={!canGoBack}
          onClick={() => void browser.go({ botId, action: "back" })}
        >
          ←
        </button>
        <button
          type="button"
          className="grid h-8 w-8 place-items-center rounded-full text-[var(--qb-muted)] hover:bg-[var(--qb-surface-2)] hover:text-[var(--qb-ink)] disabled:opacity-40"
          aria-label="Avançar"
          disabled={!canGoForward}
          onClick={() => void browser.go({ botId, action: "forward" })}
        >
          →
        </button>
        <button
          type="button"
          className="grid h-8 w-8 place-items-center rounded-full text-[var(--qb-muted)] hover:bg-[var(--qb-surface-2)] hover:text-[var(--qb-ink)]"
          aria-label="Recarregar"
          onClick={() => void browser.go({ botId, action: "reload" })}
        >
          ↻
        </button>
        <input
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder="Digite um endereço"
          aria-label={`Endereço do navegador de ${botName}`}
          className="min-w-0 flex-1 rounded-full border border-[var(--qb-hairline)] bg-[var(--qb-surface)] px-4 py-1.5 text-[14px] text-[var(--qb-ink)] outline-none focus:border-[var(--qb-ink)]"
        />
        <button type="submit" className="sr-only">
          Abrir
        </button>
      </form>
      {waiting ? (
        <p className="shrink-0 border-b border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] px-4 py-2 text-[13px] text-[var(--qb-ink)]">
          {botName} precisa que você termine o login aqui. Este navegador é só do app desktop —
          não é o Chrome deste computador nem a tela Linux.
        </p>
      ) : (
        <p className="sr-only">
          Navegador embutido de {botName}. Cookies ficam em persist:bot-{botId}.
        </p>
      )}
      <div ref={mountRef} className="min-h-0 flex-1 bg-[var(--qb-canvas)]" data-bot-browser={botId} />
      <p className="sr-only" aria-live="polite">
        {url}
      </p>
    </div>
  );
}
