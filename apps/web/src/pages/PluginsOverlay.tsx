import type {
  CapabilityInstall,
  ConnectionCatalogItem,
  DeploymentSettings,
} from "@quibt/contracts";
import { Button } from "@quibt/ui-web";
import { useEffect, useMemo, useRef, useState } from "react";
import { pollForConnection } from "../lib/connection-poll";
import { rpc } from "../lib/rpc";

let cachedCatalog: ConnectionCatalogItem[] = [];

function markConnected(items: ConnectionCatalogItem[], slug: string, connected: boolean) {
  return items.map((entry) => (entry.slug === slug ? { ...entry, connected } : entry));
}

export function PluginsOverlay({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"apps" | "skills" | "mcp">("apps");
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<ConnectionCatalogItem[]>(cachedCatalog);
  const [skills, setSkills] = useState<CapabilityInstall[]>([]);
  const [mcps, setMcps] = useState<CapabilityInstall[]>([]);
  const [skillName, setSkillName] = useState("");
  const [skillBody, setSkillBody] = useState("");
  const [mcpName, setMcpName] = useState("");
  const [mcpSource, setMcpSource] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(cachedCatalog.length === 0);
  // A chave do Composio é do deploy: só quem instalou o Quibt vê o campo para colar.
  const [composioKey, setComposioKey] = useState<{
    isOwner: boolean;
    source: DeploymentSettings["composioKeySource"];
  } | null>(null);
  const [composioDraft, setComposioDraft] = useState("");
  const [composioEditing, setComposioEditing] = useState(false);
  const open = useRef(true);

  async function refresh() {
    const [items, installs] = await Promise.all([
      rpc.connections.catalog({}),
      rpc.capabilities.list().catch(() => [] as CapabilityInstall[]),
    ]);
    cachedCatalog = items;
    setCatalog(items);
    setSkills(installs.filter((row) => row.kind === "skill"));
    setMcps(installs.filter((row) => row.kind === "mcp"));
    return items;
  }

  useEffect(() => {
    void rpc
      .me()
      .then(async (me) => {
        if (!me.isDeploymentOwner) return { isOwner: false, source: "none" as const };
        const settings = await rpc.deployment.get().catch(() => null);
        return { isOwner: true, source: settings?.composioKeySource ?? ("none" as const) };
      })
      .then(setComposioKey)
      .catch(() => setComposioKey(null));
  }, []);

  async function saveComposioKey(next: string | null) {
    setError(null);
    setPending("composio-key");
    try {
      const settings = await rpc.deployment.update({ composioApiKey: next });
      setComposioKey({ isOwner: true, source: settings.composioKeySource });
      setComposioDraft("");
      setComposioEditing(false);
      setLoading(true);
      await refresh().finally(() => setLoading(false));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível salvar a chave");
    } finally {
      setPending(null);
    }
  }

  useEffect(() => {
    open.current = true;
    void refresh()
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Não foi possível carregar o catálogo"),
      )
      .finally(() => setLoading(false));
    // Closing the overlay must also stop whatever it left polling.
    return () => {
      open.current = false;
    };
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return catalog;
    return catalog.filter(
      (item) =>
        item.name.toLowerCase().includes(needle) || item.slug.toLowerCase().includes(needle),
    );
  }, [catalog, query]);

  function setItemConnected(slug: string, connected: boolean) {
    cachedCatalog = markConnected(cachedCatalog, slug, connected);
    setCatalog((prev) => markConnected(prev, slug, connected));
  }

  async function connect(item: ConnectionCatalogItem) {
    setError(null);
    setPending(item.slug);
    try {
      const started = await rpc.connections.begin({
        provider: item.slug,
        displayName: item.name,
        redirectUrl: `${window.location.origin}/plugins/callback`,
      });
      if (started.authorizationUrl)
        window.open(started.authorizationUrl, "_blank", "noopener,noreferrer");
      if (item.noAuth && !started.authorizationUrl) {
        setItemConnected(item.slug, true);
        return;
      }
      const result = await pollForConnection({
        attempts: 45,
        delayMs: 2000,
        cancelled: () => !open.current,
        check: () => rpc.connections.complete({ connectionId: started.connectionId }),
      });
      if (result === "connected") {
        setItemConnected(item.slug, true);
        return;
      }
      if (result === "timeout") {
        setError(`A conexão com ${item.name} não foi concluída. Tente de novo.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível conectar");
    } finally {
      setPending(null);
    }
  }

  async function revoke(item: ConnectionCatalogItem) {
    setError(null);
    setPending(item.slug);
    try {
      const rows = await rpc.connections.list();
      const row = rows.find(
        (entry) => entry.provider === item.slug && entry.status === "connected",
      );
      if (!row) {
        setError(`Nenhum registro de conexão encontrado para ${item.name}.`);
        return;
      }
      await rpc.connections.revoke({ connectionId: row.id });
      setItemConnected(item.slug, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível revogar a conexão");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="qb-plugins absolute inset-0 z-30 flex items-center justify-center p-10">
      <div className="qb-plugins__card flex max-h-full w-[560px] max-w-full flex-col overflow-hidden rounded-[18px]">
        <div className="flex items-start justify-between px-6 pt-5">
          <div>
            <div className="text-[19px] font-semibold text-[var(--qb-ink)]">Plugins</div>
            <p className="mt-1 text-[13.5px] text-[var(--qb-muted)]">
              {loading
                ? "Carregando catálogo…"
                : tab === "apps"
                  ? `${catalog.length} apps`
                  : tab === "skills"
                    ? `${skills.length} skills`
                    : `${mcps.length} servidores MCP`}
            </p>
          </div>
          <button
            type="button"
            aria-label="Fechar plugins"
            onClick={onClose}
            className="text-[var(--qb-muted)]"
          >
            ✕
          </button>
        </div>
        <div className="qb-plugins__tabs flex gap-5 px-6 pt-4">
          {(
            [
              ["apps", "Apps"],
              ["skills", "Skills"],
              ["mcp", "MCP"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-pressed={tab === id}
              className="qb-plugins__tab text-[14.5px]"
            >
              {label}
            </button>
          ))}
        </div>
        <div className="px-6 pt-4">
          {tab === "apps" ? (
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar apps"
              className="w-full rounded-[13px] border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] px-4 py-3 text-[15px] text-[var(--qb-ink)] outline-none"
            />
          ) : (
            <p className="text-[13.5px] text-[var(--qb-muted)]">
              {tab === "skills"
                ? "Uma skill ensina o como. No composer, digite / para usar."
                : "Um servidor MCP traz ferramentas de fora para os seus bots."}
            </p>
          )}
        </div>
        <div className="rk-scroll flex-1 overflow-y-auto px-6 py-5">
          {error ? <p className="mb-4 text-sm text-[var(--qb-danger)]">{error}</p> : null}
          {tab === "skills" ? (
            <div>
              <label className="block text-[13px] text-[var(--qb-muted)]">
                Nome
                <input
                  value={skillName}
                  onChange={(e) => setSkillName(e.target.value)}
                  placeholder="Weekly account health"
                  className="mt-2 w-full rounded-[13px] border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] px-4 py-3 text-[15px] text-[var(--qb-ink)] outline-none"
                />
              </label>
              <label className="mt-4 block text-[13px] text-[var(--qb-muted)]">
                Instruções
                <textarea
                  value={skillBody}
                  onChange={(e) => setSkillBody(e.target.value)}
                  rows={5}
                  placeholder="Quando usar, passos, o que devolver, o que precisa de aprovação."
                  className="mt-2 w-full rounded-[13px] border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] px-4 py-3 text-[15px] text-[var(--qb-ink)] outline-none"
                />
              </label>
              <Button
                type="button"
                variant="pill"
                size="sm"
                disabled={!skillName.trim() || !skillBody.trim() || pending === "skill"}
                className="mt-4"
                onClick={() => {
                  setPending("skill");
                  setError(null);
                  void rpc.capabilities
                    .install({
                      kind: "skill",
                      name: skillName.trim(),
                      source: "user",
                      config: { instructions: skillBody.trim() },
                    })
                    .then(() => {
                      setSkillName("");
                      setSkillBody("");
                      return refresh();
                    })
                    .catch((err: unknown) =>
                      setError(
                        err instanceof Error ? err.message : "Não foi possível salvar a skill",
                      ),
                    )
                    .finally(() => setPending(null));
                }}
              >
                {pending === "skill" ? "Salvando…" : "Salvar skill"}
              </Button>
              <div className="mt-6">
                {skills.length === 0 ? (
                  <p className="text-[var(--qb-muted)]">
                    Nenhuma skill ainda. A primeira que você salvar aparece aqui e no composer
                    quando você digitar /.
                  </p>
                ) : null}
                {skills.map((skill) => (
                  <div key={skill.id} className="flex items-start gap-3 rounded-[13px] px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-[15.5px] font-medium text-[var(--qb-ink)]">
                        /{skill.name}
                      </div>
                      <div className="mt-1 line-clamp-2 text-[13.5px] text-[var(--qb-muted)]">
                        {typeof skill.config.instructions === "string"
                          ? skill.config.instructions
                          : skill.source}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="pill"
                      size="sm"
                      onClick={() => {
                        void rpc.capabilities
                          .remove({ id: skill.id })
                          .then(() => refresh())
                          .catch((err: unknown) =>
                            setError(
                              err instanceof Error ? err.message : "Não foi possível remover",
                            ),
                          );
                      }}
                    >
                      Remover
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {tab === "mcp" ? (
            <div className="rounded-[16px] border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] p-4">
              <p className="text-[13px] text-[var(--qb-muted)]">
                Servidor MCP HTTP. Sem Composio: cole a URL que responde tools/list e tools/call.
              </p>
              <label className="mt-4 block text-[13px] text-[var(--qb-muted)]">
                Nome
                <input
                  value={mcpName}
                  onChange={(e) => setMcpName(e.target.value)}
                  placeholder="Notas locais"
                  className="mt-2 w-full rounded-[13px] border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] px-4 py-3 text-[15px] text-[var(--qb-ink)] outline-none"
                />
              </label>
              <label className="mt-4 block text-[13px] text-[var(--qb-muted)]">
                URL
                <input
                  value={mcpSource}
                  onChange={(e) => setMcpSource(e.target.value)}
                  placeholder="http://127.0.0.1:8755/mcp"
                  className="mt-2 w-full rounded-[13px] border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] px-4 py-3 text-[15px] text-[var(--qb-ink)] outline-none"
                />
              </label>
              <Button
                type="button"
                variant="pill"
                size="sm"
                disabled={!mcpName.trim() || !mcpSource.trim() || pending === "mcp"}
                className="mt-4"
                onClick={() => {
                  setPending("mcp");
                  setError(null);
                  void rpc.capabilities
                    .install({
                      kind: "mcp",
                      name: mcpName.trim(),
                      source: mcpSource.trim(),
                      config: {},
                    })
                    .then(() => {
                      setMcpName("");
                      setMcpSource("");
                      return refresh();
                    })
                    .catch((err: unknown) =>
                      setError(
                        err instanceof Error ? err.message : "Não foi possível salvar o MCP",
                      ),
                    )
                    .finally(() => setPending(null));
                }}
              >
                {pending === "mcp" ? "Salvando…" : "Adicionar MCP"}
              </Button>
              <div className="mt-6">
                {mcps.length === 0 ? (
                  <p className="text-[var(--qb-muted)]">Nenhum servidor MCP ainda.</p>
                ) : null}
                {mcps.map((row) => (
                  <div key={row.id} className="flex items-start gap-3 rounded-[13px] px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-[15.5px] font-medium text-[var(--qb-ink)]">
                        {row.name}
                      </div>
                      <div className="mt-1 text-[13.5px] text-[var(--qb-muted)]">{row.source}</div>
                    </div>
                    <Button
                      type="button"
                      variant="pill"
                      size="sm"
                      onClick={() => {
                        void rpc.capabilities
                          .remove({ id: row.id })
                          .then(() => refresh())
                          .catch((err: unknown) =>
                            setError(
                              err instanceof Error ? err.message : "Não foi possível remover",
                            ),
                          );
                      }}
                    >
                      Remover
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {tab === "apps" && !loading && (catalog.length === 0 || composioEditing) ? (
            <div className="qb-plugins__key">
              {composioKey?.isOwner ? (
                <>
                  <p className="text-[14px] text-[var(--qb-ink)]">
                    {composioKey.source === "stored" || composioKey.source === "env"
                      ? "Trocar a chave do Composio"
                      : "Os apps vêm da sua conta Composio."}
                  </p>
                  <p className="mt-1 text-[13px] text-[var(--qb-muted)]">
                    Crie uma chave em{" "}
                    <a
                      href="https://platform.composio.dev/settings"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[var(--qb-accent)] underline"
                    >
                      platform.composio.dev
                    </a>{" "}
                    e cole aqui. Ela fica criptografada neste computador e vale para todos os bots.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <input
                      value={composioDraft}
                      onChange={(e) => setComposioDraft(e.target.value)}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="Chave da API do Composio"
                      aria-label="Chave da API do Composio"
                      className="min-w-0 flex-1 rounded-[13px] border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] px-4 py-2.5 text-[14px] text-[var(--qb-ink)] outline-none"
                    />
                    <Button
                      type="button"
                      variant="pill"
                      size="sm"
                      disabled={pending !== null || !composioDraft.trim()}
                      onClick={() => void saveComposioKey(composioDraft)}
                    >
                      {pending === "composio-key" ? "Salvando…" : "Usar esta chave"}
                    </Button>
                    {composioEditing ? (
                      <Button
                        type="button"
                        variant="pill"
                        size="sm"
                        onClick={() => {
                          setComposioEditing(false);
                          setComposioDraft("");
                        }}
                      >
                        Cancelar
                      </Button>
                    ) : null}
                  </div>
                </>
              ) : composioKey ? (
                <p className="text-[var(--qb-muted)]">
                  Peça a quem instalou o Quibt para colar a chave do Composio em Plugins.
                </p>
              ) : (
                <p className="text-[var(--qb-muted)]">
                  O Composio não está configurado neste deploy.
                </p>
              )}
            </div>
          ) : null}
          {tab === "apps" &&
          !loading &&
          catalog.length > 0 &&
          !composioEditing &&
          composioKey?.isOwner ? (
            <div className="qb-plugins__key-row">
              <span className="text-[13px] text-[var(--qb-muted)]">
                {composioKey.source === "env"
                  ? "Chave do Composio definida no servidor (COMPOSIO_API_KEY)."
                  : "Apps da sua conta Composio."}
              </span>
              {composioKey.source === "env" ? null : (
                <span className="flex gap-3">
                  <button
                    type="button"
                    className="text-[13px] text-[var(--qb-accent)]"
                    onClick={() => setComposioEditing(true)}
                  >
                    Trocar chave
                  </button>
                  <button
                    type="button"
                    className="text-[13px] text-[var(--qb-danger)]"
                    disabled={pending !== null}
                    onClick={() => void saveComposioKey(null)}
                  >
                    Remover
                  </button>
                </span>
              )}
            </div>
          ) : null}
          {tab === "apps"
            ? visible.map((item) => (
                <div key={item.slug} className="flex items-center gap-4 rounded-[13px] px-3 py-2.5">
                  {item.logo ? (
                    <img
                      src={item.logo}
                      alt=""
                      className="h-[42px] w-[42px] rounded-xl bg-[var(--qb-surface-2)] object-contain"
                    />
                  ) : (
                    <div className="grid h-[42px] w-[42px] place-items-center rounded-xl bg-[var(--qb-surface-2)] font-semibold">
                      {item.name[0]}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-[15.5px] font-medium text-[var(--qb-ink)]">
                      {item.name}
                    </div>
                    <div className="text-[13.5px] text-[var(--qb-muted)]">
                      {item.slug}
                      {item.noAuth ? " · sem auth" : ""}
                    </div>
                  </div>
                  {item.connected ? (
                    <Button
                      type="button"
                      variant="pill"
                      size="sm"
                      disabled={pending === item.slug}
                      onClick={() => void revoke(item)}
                    >
                      {pending === item.slug ? "Revogando…" : "Revogar"}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="pill"
                      size="sm"
                      disabled={pending === item.slug}
                      onClick={() => void connect(item)}
                    >
                      {pending === item.slug ? "Conectando…" : "Conectar"}
                    </Button>
                  )}
                </div>
              ))
            : null}
        </div>
      </div>
    </div>
  );
}
