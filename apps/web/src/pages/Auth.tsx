import { BotAvatar } from "@quibt/ui-web";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { desktopBridge } from "../lib/desktop";
import { enterApp, onboardingPath } from "../lib/enter-app";
import { claimLocalSession, isLoopbackOrigin } from "../lib/local-session";
import {
  claimOwnerEnrollmentCode,
  validWebOwnerEnrollment,
  type WebOwnerEnrollment,
} from "../lib/owner-enrollment";
import { rpc } from "../lib/rpc";
import { WindowChrome } from "./WindowChrome";

/**
 * A porta de entrada de uma instalação que mora na máquina de quem a usa.
 *
 * Não há e-mail nem senha em lugar nenhum daqui. O instalador nativo entrega o convite
 * diretamente; no navegador, a pessoa digita o código que apareceu no terminal. Sobram
 * dois caminhos, e o servidor diz qual é o desta tela: a primeira conta usa o convite da
 * instalação; qualquer aparelho depois dela entra pelo código aprovado por quem já está dentro.
 *
 * Uma pergunta por tela, e só ela: o que explica o produto já ficou na tela anterior.
 */
export function AuthPage() {
  const [params] = useSearchParams();
  const [name, setName] = useState("");
  const [installerCode, setInstallerCode] = useState("");
  const [ownerEnrollment, setOwnerEnrollment] = useState<WebOwnerEnrollment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** `null` enquanto o servidor não respondeu: nem uma tela nem outra até saber qual é. */
  const [firstOwner, setFirstOwner] = useState<boolean | null>(null);
  const plan = params.get("plan");
  const nativeInstaller = Boolean(desktopBridge());

  useEffect(() => {
    void rpc
      .health()
      .then((health) => setFirstOwner(health.needsFirstOwner))
      .catch(() => setFirstOwner(false));
  }, []);

  useEffect(() => {
    if (plan) sessionStorage.setItem("quibt.plan", plan);
  }, [plan]);

  // Quem abre esta tela no computador onde o Quibt roda é o dono (ou está no teclado dele):
  // a conta já existe, e pedir um código aqui era mandar a pessoa para um beco. Entra.
  useEffect(() => {
    if (firstOwner !== false || !isLoopbackOrigin()) return;
    void claimLocalSession().then((entered) => {
      if (entered) enterApp("/app");
    });
  }, [firstOwner]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending || !name.trim()) return;
    setPending(true);
    setError(null);
    let enrollmentToken = validWebOwnerEnrollment(ownerEnrollment);
    if (!nativeInstaller && !enrollmentToken) {
      const claimed = await claimOwnerEnrollmentCode(installerCode);
      if (!claimed.ok) {
        setPending(false);
        setError(claimed.message);
        return;
      }
      setOwnerEnrollment(claimed.enrollment);
      enrollmentToken = claimed.enrollment.token;
    }
    // O cliente do better-auth exige e-mail e senha antes de sair do navegador; aqui
    // não há nenhum dos dois para dar. A rota é a mesma, e o servidor preenche o resto.
    const res = await fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(enrollmentToken ? { "x-quibt-enrollment": enrollmentToken } : {}),
      },
      credentials: "include",
      body: JSON.stringify({ name: name.trim() }),
    }).catch(() => null);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as { message?: string } | null;
      if (res?.status === 403 || res?.status === 409) setOwnerEnrollment(null);
      setPending(false);
      setError(body?.message ?? "Não foi possível criar a conta. Tente de novo.");
      return;
    }
    // O cookie acabou de nascer; a sessão em memória não sabe dele. Ver lib/enter-app.ts.
    enterApp(onboardingPath(plan));
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
        {firstOwner === null ? (
          <p className="qb-entry__muted">Um instante…</p>
        ) : firstOwner ? (
          <form onSubmit={submit} className="qb-entry__card">
            <h1>Como você se chama?</h1>
            <p className="qb-entry__lede">
              Sem e-mail e sem senha. O convite do instalador confirma que o servidor é seu.
            </p>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Seu nome"
              autoComplete="name"
              aria-label="Seu nome"
              required
              // biome-ignore lint/a11y/noAutofocus: é o único campo da tela, e o único passo dela.
              autoFocus
              className="qb-entry__input"
            />
            {!nativeInstaller ? (
              <input
                value={installerCode}
                onChange={(event) => setInstallerCode(event.target.value.toUpperCase())}
                placeholder="Código do instalador"
                autoComplete="one-time-code"
                aria-label="Código do instalador"
                required={!validWebOwnerEnrollment(ownerEnrollment)}
                maxLength={8}
                className="qb-entry__input"
              />
            ) : null}
            {!nativeInstaller ? (
              <p className="qb-entry__foot">
                Use o código de oito caracteres mostrado por <code>quibtbot install</code> ou{" "}
                <code>quibtbot pair</code>.
              </p>
            ) : null}
            {error ? <p className="qb-entry__error">{error}</p> : null}
            <button
              type="submit"
              disabled={pending || !name.trim()}
              className="qb-primary-button qb-entry__submit"
            >
              {pending ? "Aguarde…" : "Começar"}
            </button>
          </form>
        ) : (
          <section className="qb-entry__card">
            <h1>Entrar neste aparelho</h1>
            <p className="qb-entry__lede">
              Num aparelho que já entrou, abra <strong>Conta → Celular</strong> e pegue o código.
            </p>
            <Link to="/entrar-com-codigo" className="qb-primary-button qb-entry__submit">
              Tenho o código
            </Link>
            <p className="qb-entry__foot">
              Sem nenhum aparelho conectado? Abra o Quibt no computador onde ele está instalado — lá
              a entrada é automática.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
