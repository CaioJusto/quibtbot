import {
  createQuibtCloudClient,
  isQuibtCloudLimitError,
  QuibtCloudSession,
} from "@quibt/adapters/quibt-cloud-client";
import {
  formatQuibtCloudHours,
  isQuibtCloudPlaceholderUrl,
  type QuibtCloudBox,
  type QuibtCloudLimit,
  type QuibtCloudMe,
  quibtCloudUsage,
  resolveQuibtCloudApiUrl,
} from "@quibt/core";
import { useEffect, useMemo, useState } from "react";

const SESSION_KEY = "quibt.cloud.session.v1";

export type QuibtCloudSessionPersist = {
  token: string;
  email: string;
  apiUrl: string;
  savedAt: string;
};

export function loadQuibtCloudSession(): QuibtCloudSessionPersist | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as QuibtCloudSessionPersist;
    if (!parsed.token?.trim()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveQuibtCloudSession(session: QuibtCloudSessionPersist): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearQuibtCloudSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(SESSION_KEY);
}

export interface QuibtCloudPanelProps {
  configured?: boolean;
  disabled?: boolean;
  apiUrlOverride?: string;
  onSessionToken: (token: string | null) => void;
  onApiUrl?: (url: string) => void;
  onLimit?: (limit: QuibtCloudLimit | null) => void;
}

/**
 * Login, plan usage, and box power controls for the optional Cloud provider.
 * HTTP stays in `@quibt/adapters/quibt-cloud-client`.
 */
export function QuibtCloudPanel({
  configured,
  disabled,
  apiUrlOverride,
  onSessionToken,
  onApiUrl,
  onLimit,
}: QuibtCloudPanelProps) {
  const [email, setEmail] = useState(() => loadQuibtCloudSession()?.email ?? "");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState<string | null>(() => loadQuibtCloudSession()?.token ?? null);
  const [me, setMe] = useState<QuibtCloudMe | null>(null);
  const [boxes, setBoxes] = useState<QuibtCloudBox[]>([]);
  const [limitNotice, setLimitNotice] = useState<QuibtCloudLimit | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const apiUrl = useMemo(
    () => resolveQuibtCloudApiUrl({ override: apiUrlOverride }),
    [apiUrlOverride],
  );
  const usage = useMemo(() => (me ? quibtCloudUsage(me) : null), [me]);
  const placeholderApi = isQuibtCloudPlaceholderUrl(apiUrl);

  useEffect(() => {
    onApiUrl?.(apiUrl);
  }, [apiUrl, onApiUrl]);

  useEffect(() => {
    if (!token && configured) return;
    onSessionToken(token);
  }, [configured, onSessionToken, token]);

  useEffect(() => {
    onLimit?.(limitNotice ?? usage?.limit ?? null);
  }, [limitNotice, onLimit, usage?.limit]);

  useEffect(() => {
    if (!token) return;
    void refresh(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh when token appears
  }, []);

  function cloudSession(activeToken: string) {
    return new QuibtCloudSession(createQuibtCloudClient({ baseUrl: apiUrl, token: activeToken }));
  }

  async function login() {
    setPending(true);
    setError(null);
    setInfo(null);
    setLimitNotice(null);
    try {
      const client = createQuibtCloudClient({ baseUrl: apiUrl });
      const session = new QuibtCloudSession(client);
      await session.login(email.trim(), password);
      const snap = await session.refresh();
      const nextToken = snap.token;
      if (!nextToken) throw new Error("A Cloud não devolveu token de sessão.");
      saveQuibtCloudSession({
        token: nextToken,
        email: email.trim(),
        apiUrl,
        savedAt: new Date().toISOString(),
      });
      setToken(nextToken);
      setPassword("");
      setMe(snap.me);
      setBoxes(snap.boxes);
      onSessionToken(nextToken);
      setInfo("Conta Cloud conectada.");
    } catch (err) {
      const raw = err instanceof Error ? err.message : "";
      setError(
        /failed to fetch|networkerror|load failed/i.test(raw)
          ? placeholderApi
            ? `Não foi possível alcançar a API Cloud (${apiUrl}). Defina QUIBT_CLOUD_API_URL quando o backend estiver pronto.`
            : `Não foi possível alcançar a API Cloud (${apiUrl}). Confira a URL e a rede.`
          : raw || "Não foi possível entrar na conta Cloud",
      );
    } finally {
      setPending(false);
    }
  }

  async function refresh(activeToken = token) {
    if (!activeToken) return;
    setPending(true);
    setError(null);
    try {
      const snap = await cloudSession(activeToken).refresh();
      setMe(snap.me);
      setBoxes(snap.boxes);
      setLimitNotice(snap.limit);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível atualizar a conta Cloud");
    } finally {
      setPending(false);
    }
  }

  async function resumeBox(boxId: string) {
    if (!token) return;
    setPending(true);
    setError(null);
    setLimitNotice(null);
    try {
      const snap = await cloudSession(token).resume(boxId);
      setMe(snap.me);
      setBoxes(snap.boxes);
      setLimitNotice(snap.limit);
      setInfo(`Box ${boxId} ligada.`);
    } catch (err) {
      if (isQuibtCloudLimitError(err)) {
        setLimitNotice(err.limit);
        setError(err.limit.upgradeMessage);
        return;
      }
      setError(err instanceof Error ? err.message : "Não foi possível ligar a box");
    } finally {
      setPending(false);
    }
  }

  async function stopBox(boxId: string) {
    if (!token) return;
    setPending(true);
    setError(null);
    try {
      const snap = await cloudSession(token).stop(boxId);
      setMe(snap.me);
      setBoxes(snap.boxes);
      setLimitNotice(snap.limit);
      setInfo(`Box ${boxId} desligada.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível desligar a box");
    } finally {
      setPending(false);
    }
  }

  function logout() {
    clearQuibtCloudSession();
    setToken(null);
    setPassword("");
    setMe(null);
    setBoxes([]);
    setLimitNotice(null);
    onSessionToken(null);
  }

  return (
    <div className="mt-4 grid gap-3 border-t border-[var(--qb-hairline)] pt-4">
      <p className="text-[12px] leading-[1.45] text-[var(--qb-muted)]">
        Opcional. Entre na conta Quibt Bot Cloud para ligar uma VM isolada do plano. Docker, VPS,
        E2B, Box e Daytona continuam sem essa conta.
      </p>
      {placeholderApi ? (
        <p className="rounded-xl border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] px-3 py-2 text-[11px] leading-[1.45] text-[var(--qb-muted-2)]">
          API Cloud em modo placeholder ({apiUrl}). Defina <code>QUIBT_CLOUD_API_URL</code> quando o
          backend estiver pronto.
        </p>
      ) : null}

      {!token ? (
        <>
          <label className="block text-[12px] text-[var(--qb-muted)]">
            E-mail da conta Cloud
            <input
              type="email"
              value={email}
              disabled={disabled || pending}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              className="mt-1 w-full rounded-xl border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] px-3.5 py-2 text-[13px] text-[var(--qb-ink)] outline-none focus:border-[var(--qb-accent)]"
            />
          </label>
          <label className="block text-[12px] text-[var(--qb-muted)]">
            Senha
            <input
              type="password"
              value={password}
              disabled={disabled || pending}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              className="mt-1 w-full rounded-xl border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] px-3.5 py-2 text-[13px] text-[var(--qb-ink)] outline-none focus:border-[var(--qb-accent)]"
            />
          </label>
          <button
            type="button"
            disabled={disabled || pending || !email.trim() || !password}
            onClick={() => void login()}
            className="qb-primary-button w-fit disabled:opacity-40"
          >
            {pending ? "Entrando…" : "Entrar na conta Cloud"}
          </button>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[13px] font-semibold text-[var(--qb-ink)]">
                {me?.plan.name ?? "Plano Cloud"}
              </p>
              <p className="text-[12px] text-[var(--qb-muted)]">
                {me ? formatQuibtCloudHours(me) : "Carregando uso…"}
              </p>
              {usage ? (
                <p className="text-[11px] text-[var(--qb-muted-2)]">
                  {usage.concurrentComputers}/{usage.concurrentLimit} computador(es) ligados agora
                </p>
              ) : null}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={disabled || pending}
                onClick={() => void refresh()}
                className="qb-secondary-button disabled:opacity-40"
              >
                Atualizar
              </button>
              <button
                type="button"
                disabled={disabled || pending}
                onClick={logout}
                className="qb-secondary-button disabled:opacity-40"
              >
                Sair
              </button>
            </div>
          </div>
          {usage ? (
            <div
              className="h-2 overflow-hidden rounded-full bg-[var(--qb-inset)]"
              aria-hidden="true"
            >
              <div
                className="h-full rounded-full bg-[var(--qb-accent)] transition-[width]"
                style={{ width: `${Math.round(usage.hoursRatio * 100)}%` }}
              />
            </div>
          ) : null}
          <div className="grid gap-2">
            {boxes.length ? (
              boxes.map((box) => (
                <div
                  key={box.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] px-3 py-2"
                >
                  <div>
                    <p className="text-[13px] font-medium text-[var(--qb-ink)]">{box.id}</p>
                    <p className="text-[11px] text-[var(--qb-muted)]">
                      {box.status === "running" ? "Ligada" : "Desligada"}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {box.status === "running" ? (
                      <button
                        type="button"
                        disabled={disabled || pending}
                        onClick={() => void stopBox(box.id)}
                        className="qb-secondary-button disabled:opacity-40"
                      >
                        Desligar
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={disabled || pending}
                        onClick={() => void resumeBox(box.id)}
                        className="qb-primary-button disabled:opacity-40"
                      >
                        Ligar
                      </button>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <p className="text-[12px] text-[var(--qb-muted)]">
                Nenhuma box na conta ainda. Crie uma no painel Cloud e toque em Atualizar.
              </p>
            )}
          </div>
        </>
      )}

      {limitNotice ? (
        <p className="rounded-xl border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] px-3 py-2 text-[12px] leading-[1.45] text-[var(--qb-muted)]">
          {limitNotice.upgradeMessage}
        </p>
      ) : null}
      {info ? <p className="text-[12px] text-[var(--qb-muted)]">{info}</p> : null}
      {error ? (
        <p className="rounded-xl px-3 py-2 text-[12px] text-[var(--qb-ink)]">{error}</p>
      ) : null}
    </div>
  );
}
