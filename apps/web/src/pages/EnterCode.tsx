import { formatDeviceCode, isWellFormedDeviceCode } from "@quibt/core/device-code";
import { BotAvatar } from "@quibt/ui-web";
import { useEffect, useState } from "react";
import { enterApp } from "../lib/enter-app";
import { claimLocalSession, isLoopbackOrigin } from "../lib/local-session";
import { WindowChrome } from "./WindowChrome";

/**
 * Entrar sem e-mail e sem senha.
 *
 * A conta mora nesta instalação — não há nuvem onde recuperá-la, e ela não envia
 * e-mail. Então o que vale como prova é ter acesso a um aparelho que já entrou:
 * ele mostra um código de oito caracteres (Conta → Celular) e este aqui digita.
 */
type PairBody = {
  requestId?: string;
  secret?: string;
  state?: string;
  message?: string;
};

/** O nome que aparece no computador de quem vai aprovar: "entrar neste Chrome do Mac". */
function deviceName(): string {
  const agent = navigator.userAgent;
  const browser = /Firefox/.test(agent)
    ? "Firefox"
    : /Edg\//.test(agent)
      ? "Edge"
      : /Chrome/.test(agent)
        ? "Chrome"
        : /Safari/.test(agent)
          ? "Safari"
          : "Navegador";
  const os = /Mac/.test(agent)
    ? "Mac"
    : /Windows/.test(agent)
      ? "Windows"
      : /Linux/.test(agent)
        ? "Linux"
        : "";
  return os ? `${browser} no ${os}` : browser;
}

export function EnterCodePage() {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const ready = isWellFormedDeviceCode(code);

  // No computador do próprio Quibt não há código a digitar: a máquina é a prova. Entra.
  useEffect(() => {
    if (!isLoopbackOrigin()) return;
    void claimLocalSession().then((entered) => {
      if (entered) enterApp("/app");
    });
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || pending) return;
    setPending(true);
    setError(null);
    const claimed = await fetch("/api/pairing/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ code, device: deviceName() }),
    })
      .then(async (res) => ({ ok: res.ok, body: (await res.json().catch(() => ({}))) as PairBody }))
      .catch(() => null);
    if (!claimed?.ok || !claimed.body.requestId || !claimed.body.secret) {
      setPending(false);
      setError(claimed?.body?.message ?? "Não foi possível entrar com esse código.");
      return;
    }
    // Acertar o código só faz o pedido: quem está no computador ainda precisa dizer sim.
    setWaiting(true);
    const request = { requestId: claimed.body.requestId, secret: claimed.body.secret };
    for (let attempt = 0; attempt < 150; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const polled = await fetch("/api/pairing/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(request),
      })
        .then(async (res) => (await res.json().catch(() => ({}))) as PairBody)
        .catch(() => null);
      if (polled?.state === "approved") {
        // O sim do computador gravou o cookie agora; a sessão em memória ainda é a velha.
        enterApp("/app");
        return;
      }
      if (polled?.state && polled.state !== "pending") {
        setPending(false);
        setWaiting(false);
        setError(
          polled.state === "denied"
            ? "O pedido foi recusado no computador."
            : "O pedido venceu. Peça um código novo.",
        );
        return;
      }
    }
    setPending(false);
    setWaiting(false);
    setError("Ninguém confirmou no computador. Tente de novo.");
  }

  return (
    <div className="qb-entry">
      <header className="qb-entry__header app-drag">
        <WindowChrome />
        <div className="qb-entry__wordmark">
          <BotAvatar color="#5B7FE5" shape="strobi" size={28} />
          <span>Quibt Bot</span>
        </div>
      </header>
      <main className="qb-entry__main">
        <form onSubmit={submit} className="qb-entry__card">
          <h1>Digite o código</h1>
          <p className="qb-entry__lede">
            Ele aparece em <strong>Conta → Celular</strong> num aparelho que já entrou.
          </p>
          <input
            value={formatDeviceCode(code)}
            onChange={(event) => setCode(event.target.value.replace(/\s+/g, "").slice(0, 8))}
            placeholder="ABCD 1234"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Código de entrada"
            // biome-ignore lint/a11y/noAutofocus: é o único campo da tela.
            autoFocus
            className="qb-entry__input qb-entry__input--code rk-mono"
          />
          {waiting ? (
            <p className="qb-entry__hint">Pedido enviado. Confirme no outro aparelho que é você.</p>
          ) : null}
          {error ? <p className="qb-entry__error">{error}</p> : null}
          <button
            type="submit"
            disabled={!ready || pending}
            className="qb-primary-button qb-entry__submit"
          >
            {waiting ? "Aguardando o sim…" : pending ? "Entrando…" : "Entrar"}
          </button>
          <p className="qb-entry__foot">
            Perdeu todos os aparelhos? Abra o Quibt no computador onde ele está instalado — lá a
            entrada é automática.
          </p>
        </form>
      </main>
    </div>
  );
}
