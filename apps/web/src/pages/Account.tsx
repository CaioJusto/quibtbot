import type { BillingSnapshot } from "@quibt/contracts";
import {
  chooseMode,
  chooseProvider,
  connectedModelNotice,
  displayPlanName,
  displayPlanStatus,
  formatMeter,
  formatTokenBudget,
  localModelUrl,
  modeForProvider,
  providersForMode,
  type QuibtEdition,
  startPolling,
  type TokenSource,
} from "@quibt/core";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { authClient } from "../lib/auth";
import {
  defaultSourceLabel,
  modelSourceBody,
  planSwitchDone,
  planSwitchLabel,
  resolveClientEdition,
} from "../lib/edition-client";
import { rpc } from "../lib/rpc";
import { MachineSettingsBody } from "./MachineSettings";

const switchModelsToPlan = rpc.models.usePlan;

type ModelCatalogEntry = {
  provider: string;
  providerName?: string;
  id: string;
  label?: string;
  oauthLabel?: string;
  auth?: "api-key" | "oauth" | "both";
  subscription?: boolean;
  signIn?: "device-code";
};

const field = "qb-account-field";
const primary = "qb-account-primary";
const ghost = "qb-account-ghost";

export type AccountTab = "profile" | "models" | "machine" | "security";

const TABS: Array<{ id: AccountTab; label: string }> = [
  { id: "profile", label: "Perfil" },
  { id: "models", label: "Modelo" },
  { id: "machine", label: "Máquina" },
  { id: "security", label: "Segurança" },
];

/** Rota antiga (/account) — o mesmo conteúdo do modal, numa página leve. */
export function AccountPage() {
  const navigate = useNavigate();
  return (
    <div className="qb-settings-page min-h-full px-6 py-8 text-[var(--qb-ink)]">
      <div className="mx-auto w-full max-w-[640px]">
        <button type="button" onClick={() => navigate("/app")} className="qb-settings-back">
          ← Voltar à inbox
        </button>
        <div className="qb-settings-card mt-5">
          <AccountSettingsBody />
        </div>
      </div>
    </div>
  );
}

/**
 * Conta dentro do app: abas Perfil / Modelo / Máquina / Segurança no mesmo modal
 * das outras configurações. Antes o clique no perfil trocava de página inteira,
 * com herói, mascote e menu lateral — muita coisa para trocar um nome.
 */
export function AccountSettingsBody({
  initialTab = "profile",
  onSignedOut,
}: {
  initialTab?: AccountTab;
  onSignedOut?: () => void;
} = {}) {
  const [tab, setTab] = useState<AccountTab>(initialTab);

  const navigate = useNavigate();
  const session = authClient.useSession();
  const user = session.data?.user;
  const [name, setName] = useState(user?.name ?? "");
  const [billing, setBilling] = useState<BillingSnapshot | null>(null);
  const [edition, setEdition] = useState<QuibtEdition>("oss");
  const [usage, setUsage] = useState<{
    runs: number;
    inputTokens: number;
    outputTokens: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<
    Array<{ id: string; provider: string; label: string; isDefault: boolean }>
  >([]);
  const [signInOptions, setSignInOptions] = useState<
    Array<{ provider: string; id: string; oauthLabel?: string; providerName?: string }>
  >([]);
  // Trocar de provedor era coisa só do onboarding: quem já tinha passado por ele ficava
  // preso ao modelo escolhido naquele dia, sem lugar nenhum no app para colar outra chave.
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [tokenSource, setTokenSource] = useState<TokenSource>("key");
  const [provider, setProvider] = useState("openrouter");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [oauthFlow, setOauthFlow] = useState<
    | { state: "idle" }
    | { state: "waiting"; loginId: string; userCode: string; verificationUri: string }
    | { state: "error"; error: string }
  >({ state: "idle" });

  useEffect(() => {
    if (user?.name) setName(user.name);
  }, [user?.name]);

  useEffect(() => {
    void Promise.all([
      rpc.billing.get().catch(() => null),
      rpc.usage.summary().catch(() => null),
      rpc.models.credentials().catch(() => []),
      rpc.models.list().catch(() => []),
      rpc.health().catch(() => null),
      rpc.me().catch(() => null),
    ]).then(([snap, week, creds, catalog, health, me]) => {
      setBilling(snap);
      setEdition(resolveClientEdition({ health, me, billing: snap }));
      setUsage(week);
      setCredentials(creds);
      setCatalog(catalog);
      // A tela tem de abrir no que o deploy usa hoje. Ela começava sempre no primeiro
      // OpenRouter do catálogo: quem tinha assinatura conectada via "xAI" no topo e
      // "Chave OpenRouter" com um modelo qualquer logo abaixo, como se fosse o dele.
      const current =
        catalog.find(
          (entry) => entry.provider === me?.defaultProvider && entry.id === me?.defaultModel,
        ) ?? catalog.find((entry) => entry.provider === me?.defaultProvider);
      const preferred =
        current ?? catalog.find((entry) => entry.provider === "openrouter") ?? catalog[0];
      if (preferred) {
        setProvider(preferred.provider);
        setModelId(preferred.id);
      }
      if (current) setTokenSource(modeForProvider(current));
      const seen = new Map<
        string,
        { provider: string; id: string; oauthLabel?: string; providerName?: string }
      >();
      for (const entry of catalog) {
        if (entry.signIn === "device-code" && !seen.has(entry.provider)) {
          seen.set(entry.provider, entry);
        }
      }
      setSignInOptions([...seen.values()]);
    });
  }, []);

  const providers = useMemo(() => {
    const seen = new Map<string, ModelCatalogEntry>();
    for (const entry of catalog) {
      if (!seen.has(entry.provider)) seen.set(entry.provider, entry);
    }
    return providersForMode([...seen.values()], tokenSource);
  }, [catalog, tokenSource]);

  const modelsForProvider = useMemo(
    () => catalog.filter((entry) => entry.provider === provider),
    [catalog, provider],
  );

  const selectedModel =
    modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];

  function pickTokenSource(next: TokenSource) {
    setTokenSource(next);
    setError(null);
    const fixed = chooseMode({ provider, modelId, apiKey }, catalog, next);
    setProvider(fixed.provider);
    setModelId(fixed.modelId);
    setApiKey(next === "local" && !fixed.apiKey ? localModelUrl(fixed.provider) : fixed.apiKey);
  }

  function pickProvider(nextProvider: string) {
    const next = chooseProvider({ provider, modelId, apiKey }, catalog, nextProvider);
    setProvider(next.provider);
    setModelId(next.modelId);
    setApiKey(next.apiKey);
  }

  async function connectModel() {
    if (!apiKey.trim() || !selectedModel) return;
    setPending("connect");
    setError(null);
    setNotice(null);
    try {
      const credential = await rpc.models.connect({
        provider,
        apiKey,
        modelId: selectedModel.id,
        label: selectedModel.providerName ?? provider,
      });
      // Conectar sem definir como padrão deixava a credencial guardada e os bots na chave
      // antiga: quem troca de provedor está trocando o que roda, não colecionando chaves.
      await rpc.models.setDefault({ provider, modelId: selectedModel.id });
      setCredentials(await rpc.models.credentials().catch(() => []));
      // "Confirmada" só quando o servidor falou mesmo com o provedor: nos que ele não
      // sonda, a chave fica guardada e a primeira mensagem é que dirá se presta.
      setNotice(
        `${connectedModelNotice({ verified: credential.verified, local: tokenSource === "local" })} Agora os bots usam ${selectedModel.label ?? selectedModel.id}.`,
      );
      setApiKey("");
    } catch (err) {
      // Chave recusada ou sem crédito: o probe explica em português e nada foi gravado.
      setError(err instanceof Error ? err.message : "Não foi possível conectar o modelo");
    } finally {
      setPending(null);
    }
  }

  useEffect(() => {
    if (oauthFlow.state !== "waiting") return;
    const loginId = oauthFlow.loginId;
    return startPolling(
      async () => {
        const result = await rpc.models.completeOAuth({ loginId });
        if (result.status === "connected") {
          setOauthFlow({ state: "idle" });
          setNotice(`Conectado como ${result.credential.label}.`);
          setCredentials(await rpc.models.credentials());
        } else if (result.status === "error") {
          setOauthFlow({ state: "error", error: result.error });
        }
      },
      3000,
      {
        onError: (err) =>
          setOauthFlow({
            state: "error",
            error: err instanceof Error ? err.message : "Não foi possível concluir o login",
          }),
      },
    );
  }, [oauthFlow]);

  async function startSubscriptionSignIn(option: {
    provider: string;
    id: string;
    oauthLabel?: string;
    providerName?: string;
  }) {
    setError(null);
    setNotice(null);
    try {
      const begun = await rpc.models.beginOAuth({
        provider: option.provider,
        modelId: option.id,
        // O rótulo vira o nome da credencial salva: use o provedor, não o texto do botão.
        label: option.providerName ?? option.provider,
      });
      setOauthFlow({
        state: "waiting",
        loginId: begun.loginId,
        userCode: begun.userCode,
        verificationUri: begun.verificationUri,
      });
    } catch (err) {
      setOauthFlow({
        state: "error",
        error: err instanceof Error ? err.message : "Não foi possível iniciar o login",
      });
    }
  }

  async function switchToPlanTokens() {
    setPending("models");
    setError(null);
    setNotice(null);
    try {
      await switchModelsToPlan();
      setCredentials(await rpc.models.credentials().catch(() => []));
      setNotice(planSwitchDone(edition));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível trocar");
    } finally {
      setPending(null);
    }
  }

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    const next = name.trim();
    if (!next) return;
    setPending("name");
    setError(null);
    setNotice(null);
    const result = await authClient.updateUser({ name: next });
    setPending(null);
    if (result.error) {
      setError(result.error.message ?? "Não foi possível salvar o nome");
      return;
    }
    setNotice("Nome atualizado.");
  }

  async function deleteAccount() {
    if (
      !window.confirm(
        "Apagar a conta tenta cancelar a assinatura ativa e revogar integrações antes de apagar seus bots, computadores, memória e conexões. Não dá para desfazer. Continuar?",
      )
    ) {
      return;
    }
    setPending("delete");
    setError(null);
    setNotice(null);
    try {
      await rpc.account.delete();
      await authClient.signOut().catch(() => undefined);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível apagar a conta");
      setPending(null);
    }
  }

  const initial = (user?.name ?? "").trim().slice(0, 1).toUpperCase() || "U";

  async function signOut() {
    await authClient.signOut();
    onSignedOut?.();
    navigate("/");
  }

  return (
    <div className="qb-account">
      <div className="qb-account__tabs" role="tablist" aria-label="Seções da conta">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`qb-account__tab${tab === item.id ? " is-active" : ""}`}
            onClick={() => {
              setTab(item.id);
              setError(null);
              setNotice(null);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error ? <p className="qb-settings-alert is-error">{error}</p> : null}
      {notice ? <p className="qb-settings-alert is-success">{notice}</p> : null}

      {tab === "profile" ? (
        <div className="qb-account__panel">
          <div className="qb-account__me">
            <span className="qb-account-popover__avatar">{initial}</span>
            <div className="min-w-0">
              <p className="qb-account__me-name">{user?.name ?? "Você"}</p>
              <p className="qb-account__me-sub">
                {usage
                  ? `Últimos 7 dias: ${usage.runs} execuções · ${usage.inputTokens + usage.outputTokens} tokens`
                  : "Perfil desta instalação do Quibt."}
              </p>
            </div>
          </div>

          <form onSubmit={saveName} className="qb-account__row">
            <label className="qb-account__label">
              Nome
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                className={field}
              />
            </label>
            <button type="submit" disabled={pending !== null} className={primary}>
              {pending === "name" ? "Salvando…" : "Salvar"}
            </button>
          </form>

          {billing?.enabled ? (
            <div className="qb-account__block">
              <div className="flex items-baseline justify-between gap-3">
                <h3>Assinatura</h3>
                <span className="qb-account__hint">
                  {`${displayPlanName(billing)} · ${displayPlanStatus(billing.status)}`}
                </span>
              </div>
              <ul className="qb-account__meters">
                <li>Bots: {formatMeter(billing.usage.bots, billing.limits.maxBots)}</li>
                <li>
                  Tokens:{" "}
                  {formatMeter(
                    billing.usage.tokens,
                    billing.limits.tokensPerMonth,
                    formatTokenBudget,
                  )}
                </li>
                <li>
                  Computador:{" "}
                  {formatMeter(
                    Math.round(billing.usage.computerMinutes / 60),
                    billing.limits.computerMinutesPerMonth === null
                      ? null
                      : billing.limits.computerMinutesPerMonth / 60,
                    (n) => `${n}h`,
                  )}
                </li>
              </ul>
              <button type="button" onClick={() => navigate("/billing")} className={ghost}>
                Gerenciar planos e Stripe →
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === "models" ? (
        <div className="qb-account__panel">
          <div className="flex items-baseline justify-between gap-3">
            <h3>Modelos e tokens</h3>
            <span className="qb-account__hint">{defaultSourceLabel(credentials, edition)}</span>
          </div>
          <p className="qb-account__hint">
            {modelSourceBody(
              credentials.some((cred) => cred.isDefault),
              edition,
            )}
          </p>

          <fieldset className="qb-account__tabs">
            <legend className="sr-only">Fonte do modelo</legend>
            {/* Mesma ordem do onboarding: a assinatura que a pessoa já paga vem primeiro. */}
            {(
              [
                ["subscription", "Minha assinatura"],
                ["key", "Chave OpenRouter"],
                ["local", "Modelo local"],
              ] as Array<[TokenSource, string]>
            ).map(([mode, title]) => (
              <button
                key={mode}
                type="button"
                aria-pressed={tokenSource === mode}
                onClick={() => pickTokenSource(mode)}
                className={`qb-account__tab${tokenSource === mode ? " is-active" : ""}`}
              >
                {title}
              </button>
            ))}
          </fieldset>

          {tokenSource === "subscription" ? null : (
            <div className="qb-account__block">
              <div className="grid gap-3 md:grid-cols-2">
                <label className="qb-account__label">
                  Provedor
                  <select
                    value={provider}
                    onChange={(e) => pickProvider(e.target.value)}
                    className={field}
                  >
                    {providers.map((entry) => (
                      <option key={entry.provider} value={entry.provider}>
                        {entry.providerName ?? entry.provider}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="qb-account__label">
                  Modelo
                  <select
                    value={selectedModel?.id ?? modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    className={field}
                  >
                    {modelsForProvider.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label ?? entry.id}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="qb-account__label">
                {tokenSource === "local" ? "URL do modelo" : "Chave de API"}
                <input
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  type={tokenSource === "local" ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={tokenSource === "local" ? localModelUrl(provider) : "sk-…"}
                  className={field}
                />
              </label>
              {provider === "openrouter" ? (
                <p className="qb-account__hint">
                  Crie a chave em{" "}
                  <a
                    href="https://openrouter.ai/keys"
                    target="_blank"
                    rel="noreferrer"
                    className="text-[var(--qb-accent)] underline"
                  >
                    openrouter.ai/keys
                  </a>
                  . Você paga por uso na sua conta OpenRouter.
                </p>
              ) : null}
              <button
                type="button"
                disabled={pending !== null || !apiKey.trim() || !selectedModel}
                onClick={() => void connectModel()}
                className={primary}
              >
                {pending === "connect" ? "Conectando…" : "Usar este modelo"}
              </button>
            </div>
          )}
          {oauthFlow.state === "waiting" ? (
            <div className="qb-account__block">
              <p>
                Abra{" "}
                <a
                  href={oauthFlow.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[var(--qb-accent)] underline"
                >
                  {oauthFlow.verificationUri}
                </a>{" "}
                e digite o código:
              </p>
              <p className="rk-mono mt-2 text-[22px] tracking-[4px]">{oauthFlow.userCode}</p>
              <p className="qb-account__hint">Aguardando confirmação…</p>
            </div>
          ) : null}
          {oauthFlow.state === "error" ? (
            <p className="qb-settings-alert is-error">{oauthFlow.error}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {signInOptions.map((option) => (
              <button
                key={option.provider}
                type="button"
                onClick={() => void startSubscriptionSignIn(option)}
                className="qb-account-chip"
              >
                {option.oauthLabel ?? option.providerName ?? option.provider}
              </button>
            ))}
            {credentials.some((cred) => cred.isDefault) ? (
              <button
                type="button"
                disabled={pending === "models"}
                onClick={() => void switchToPlanTokens()}
                className="qb-account-chip is-accent"
              >
                {pending === "models" ? "Trocando…" : planSwitchLabel(edition)}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {tab === "machine" ? (
        <div className="qb-account__panel">
          <MachineSettingsBody />
        </div>
      ) : null}

      {tab === "security" ? (
        <div className="qb-account__panel">
          {/* Sem e-mail e sem senha: quem entra prova pelo teclado do computador (primeira
              conta) ou pelo código aprovado por um aparelho que já entrou. Um formulário de
              senha aqui prometia uma credencial que nenhuma tela pede. */}
          <div className="qb-account__block">
            <h3>Sessão</h3>
            <button type="button" onClick={() => void signOut()} className={ghost}>
              Sair desta conta
            </button>
          </div>

          <div className="qb-account__block is-danger">
            <h3>Apagar conta</h3>
            <p className="qb-account__hint">
              Tenta cancelar a assinatura ativa e revogar integrações; depois apaga seus bots,
              computadores, memória e conexões. Não dá para desfazer.
            </p>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => void deleteAccount()}
              className="qb-account-primary is-danger"
            >
              {pending === "delete" ? "Apagando…" : "Apagar minha conta"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
