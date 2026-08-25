import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { rpc } from "../lib/rpc";

/**
 * Where the provider sends the browser back after OAuth. Composio exchanges the
 * code on its side, so all this page carries is the connection row id we put on
 * the callback URL; the rest is polling `connections.complete` until the
 * connected account goes active.
 */
export function PluginsCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const started = useRef(false);

  const connectionId = params.get("connectionId") ?? "";
  const code = params.get("code") ?? undefined;
  const fromApp = params.get("app") === "1";

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!connectionId) {
      setError("O provedor voltou sem identificar a conexão.");
      return;
    }
    let cancelled = false;
    async function finish() {
      for (let attempt = 0; attempt < 20 && !cancelled; attempt += 1) {
        const row = await rpc.connections.complete({ connectionId, code }).catch(() => undefined);
        if (row?.status === "connected") {
          setDone(true);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      if (!cancelled) setError("A conexão ainda não ficou pronta. Tente de novo pelos Plugins.");
    }
    void finish();
    return () => {
      cancelled = true;
    };
  }, [connectionId, code]);

  useEffect(() => {
    if (!done || fromApp) return;
    const timer = setTimeout(() => navigate("/app", { replace: true }), 900);
    return () => clearTimeout(timer);
  }, [done, fromApp, navigate]);

  useEffect(() => {
    if (!done || !fromApp || !connectionId) return;
    const href = `quibt://plugins/callback?connectionId=${encodeURIComponent(connectionId)}`;
    window.location.assign(href);
  }, [done, fromApp, connectionId]);

  return (
    <div className="grid min-h-full place-items-center bg-[var(--qb-canvas)] px-6 text-center text-[var(--qb-ink)]">
      <div className="max-w-[420px]">
        <h1 className="text-[26px] font-semibold tracking-tight">
          {error ? "Não deu certo" : done ? "Plugin conectado" : "Conectando…"}
        </h1>
        <p className="mt-3 text-[15px] text-[var(--qb-muted)]">
          {error ??
            (done
              ? "Já pode voltar para os seus bots."
              : "Estamos confirmando a autorização com o provedor.")}
        </p>
        {fromApp && done ? (
          <a
            href={`quibt://plugins/callback?connectionId=${encodeURIComponent(connectionId)}`}
            className="mt-6 block rounded-[12px] bg-[var(--qb-ink-strong)] px-4 py-3 text-[15px] font-semibold text-[var(--qb-ink)]"
          >
            Voltar ao app
          </a>
        ) : null}
        {error ? (
          <button
            type="button"
            onClick={() => navigate("/app", { replace: true })}
            className="mt-6 text-[15px] text-[var(--qb-muted)]"
          >
            Voltar à inbox
          </button>
        ) : null}
      </div>
    </div>
  );
}
