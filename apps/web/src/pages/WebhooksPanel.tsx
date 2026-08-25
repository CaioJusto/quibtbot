import type { Bot, Me, Webhook, WebhookAttempt, WebhookCredential } from "@quibt/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Icon } from "../components/desktop-ui";
import { inboxTimeLabel } from "../lib/day-stamps";
import { rpc } from "../lib/rpc";
import { errorMessage } from "../lib/rpc-errors";
import {
  formatWebhookEventsInput,
  normalizeWebhookPublicUrl,
  parseWebhookEventsInput,
  WebhookUrlError,
  webhookActiveLabel,
  webhookCurl,
  webhookOutcomeLabel,
  webhookPublicEndpoint,
} from "../lib/webhooks";

const CARD =
  "overflow-hidden rounded-[var(--qb-r-md)] border border-[var(--qb-hairline)] bg-[var(--qb-canvas)]";

type WebhookDraft = {
  webhookId: string | null;
  name: string;
  prompt: string;
  eventsText: string;
};

function emptyDraft(): WebhookDraft {
  return { webhookId: null, name: "", prompt: "", eventsText: "" };
}

function draftFromWebhook(webhook: Webhook): WebhookDraft {
  return {
    webhookId: webhook.id,
    name: webhook.name,
    prompt: webhook.prompt,
    eventsText: formatWebhookEventsInput(webhook.eventTypes),
  };
}

type PendingAction = { webhookId: string; kind: "pause" | "delete" | "rotate" | "test" } | null;

/**
 * Deployment settings and gerenciamento de webhooks de um bot. A URL pública é
 * global (um só valor por instalação) e só quem instalou o Quibt pode mudá-la; o
 * resto só lê. Um segredo recém-criado ou girado só existe em memória deste
 * componente — fechar o painel ou recarregar a página o apaga para sempre.
 */
export function WebhooksPanel({
  bot,
  onOpenRun,
  onBack,
  onClose,
}: {
  bot: Bot;
  onOpenRun: (runId: string) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const [me, setMe] = useState<Me | null>(null);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const [publicUrlInput, setPublicUrlInput] = useState("");
  const [urlSaving, setUrlSaving] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);

  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [webhooksLoading, setWebhooksLoading] = useState(true);
  const [webhooksError, setWebhooksError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<WebhookDraft>(emptyDraft());
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [credential, setCredential] = useState<{
    webhookId: string;
    parts: WebhookCredential;
  } | null>(null);

  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [confirmingRotateId, setConfirmingRotateId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const [attempts, setAttempts] = useState<WebhookAttempt[]>([]);
  const [attemptsLoading, setAttemptsLoading] = useState(false);
  const [attemptsError, setAttemptsError] = useState<string | null>(null);
  const [attemptsVersion, setAttemptsVersion] = useState(0);

  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const copyStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyStatusTimer.current !== null) clearTimeout(copyStatusTimer.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([rpc.me(), rpc.deployment.get()])
      .then(([meResult, deployment]) => {
        if (cancelled) return;
        setMe(meResult);
        setPublicUrl(deployment.webhookPublicUrl);
        setPublicUrlInput(deployment.webhookPublicUrl ?? "");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSettingsError(errorMessage(err, "Não foi possível carregar as configurações"));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setWebhooksLoading(true);
    setWebhooksError(null);
    rpc.webhooks
      .list({ botId: bot.id })
      .then((rows) => {
        if (cancelled) return;
        setWebhooks(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setWebhooksError(errorMessage(err, "Não foi possível carregar os webhooks"));
      })
      .finally(() => {
        if (!cancelled) setWebhooksLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bot.id]);

  const selected = webhooks.find((row) => row.id === selectedId) ?? webhooks[0] ?? null;

  useEffect(() => {
    if (!selected) {
      setAttempts([]);
      return;
    }
    let cancelled = false;
    setAttemptsLoading(true);
    setAttemptsError(null);
    rpc.webhooks
      .attempts({ webhookId: selected.id, limit: 20 })
      .then((rows) => {
        if (cancelled) return;
        setAttempts(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setAttemptsError(errorMessage(err, "Não foi possível carregar a atividade"));
      })
      .finally(() => {
        if (!cancelled) setAttemptsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `attemptsVersion` has no meaning on its own — bumping it is how a manual
    // refresh (or a test/create/update side effect) re-runs this same fetch
    // without the selected webhook's id having to change.
  }, [selected?.id, attemptsVersion]);

  async function refreshWebhooks(): Promise<Webhook[]> {
    try {
      const rows = await rpc.webhooks.list({ botId: bot.id });
      setWebhooks(rows);
      setWebhooksError(null);
      return rows;
    } catch (err) {
      setWebhooksError(errorMessage(err, "Não foi possível carregar os webhooks"));
      return webhooks;
    }
  }

  function announceCopy(message: string) {
    setCopyStatus(message);
    if (copyStatusTimer.current !== null) clearTimeout(copyStatusTimer.current);
    copyStatusTimer.current = setTimeout(() => setCopyStatus(null), 4000);
  }

  function copyToClipboard(label: string, value: string) {
    navigator.clipboard.writeText(value).then(
      () => announceCopy(`${label} copiado.`),
      () => announceCopy(`Não foi possível copiar ${label.toLowerCase()}.`),
    );
  }

  async function saveUrl() {
    const trimmed = publicUrlInput.trim();
    if (!trimmed) {
      setUrlError('Digite uma URL ou use "Remover URL".');
      return;
    }
    let normalized: string;
    try {
      normalized = normalizeWebhookPublicUrl(trimmed);
    } catch (err) {
      setUrlError(err instanceof WebhookUrlError ? err.message : "URL inválida.");
      return;
    }
    setUrlError(null);
    setUrlSaving(true);
    try {
      const settings = await rpc.deployment.update({ webhookPublicUrl: normalized });
      setPublicUrl(settings.webhookPublicUrl);
      setPublicUrlInput(settings.webhookPublicUrl ?? "");
    } catch (err) {
      setUrlError(errorMessage(err, "Não foi possível salvar a URL pública"));
    } finally {
      setUrlSaving(false);
    }
  }

  async function clearUrl() {
    setUrlError(null);
    setUrlSaving(true);
    try {
      const settings = await rpc.deployment.update({ webhookPublicUrl: null });
      setPublicUrl(settings.webhookPublicUrl);
      setPublicUrlInput("");
    } catch (err) {
      setUrlError(errorMessage(err, "Não foi possível remover a URL pública"));
    } finally {
      setUrlSaving(false);
    }
  }

  function openCreateForm() {
    setDraft(emptyDraft());
    setFormError(null);
    setFormOpen(true);
  }

  function openEditForm(webhook: Webhook) {
    setDraft(draftFromWebhook(webhook));
    setFormError(null);
    setFormOpen(true);
  }

  async function submitForm() {
    const name = draft.name.trim();
    if (!name) {
      setFormError("Dê um nome a este webhook.");
      return;
    }
    const eventTypes = parseWebhookEventsInput(draft.eventsText);
    setFormError(null);
    setSaving(true);
    try {
      if (draft.webhookId) {
        await rpc.webhooks.update({
          webhookId: draft.webhookId,
          name,
          prompt: draft.prompt,
          eventTypes,
        });
        await refreshWebhooks();
      } else {
        const created = await rpc.webhooks.create({
          botId: bot.id,
          name,
          prompt: draft.prompt,
          eventTypes,
          active: true,
        });
        await refreshWebhooks();
        setSelectedId(created.webhook.id);
        setCredential({ webhookId: created.webhook.id, parts: created.credential });
      }
      setFormOpen(false);
      setAttemptsVersion((v) => v + 1);
    } catch (err) {
      setFormError(errorMessage(err, "Não foi possível salvar o webhook"));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(webhook: Webhook) {
    setRowError(null);
    setPending({ webhookId: webhook.id, kind: "pause" });
    try {
      await rpc.webhooks.update({ webhookId: webhook.id, active: !webhook.active });
      await refreshWebhooks();
    } catch (err) {
      setRowError(errorMessage(err, "Não foi possível atualizar o webhook"));
    } finally {
      setPending(null);
    }
  }

  async function runTest(webhook: Webhook) {
    setRowError(null);
    setPending({ webhookId: webhook.id, kind: "test" });
    try {
      await rpc.webhooks.testRun({ webhookId: webhook.id });
      setSelectedId(webhook.id);
      setAttemptsVersion((v) => v + 1);
      await refreshWebhooks();
    } catch (err) {
      setRowError(errorMessage(err, "Não foi possível testar este webhook"));
    } finally {
      setPending(null);
    }
  }

  async function confirmRotate(webhook: Webhook) {
    setRowError(null);
    setPending({ webhookId: webhook.id, kind: "rotate" });
    try {
      const rotated = await rpc.webhooks.rotateSecret({ webhookId: webhook.id });
      await refreshWebhooks();
      setSelectedId(webhook.id);
      setCredential({ webhookId: webhook.id, parts: rotated.credential });
    } catch (err) {
      setRowError(errorMessage(err, "Não foi possível girar o segredo"));
    } finally {
      setPending(null);
      setConfirmingRotateId(null);
    }
  }

  async function confirmDelete(webhook: Webhook) {
    setRowError(null);
    setPending({ webhookId: webhook.id, kind: "delete" });
    try {
      await rpc.webhooks.remove({ webhookId: webhook.id });
      await refreshWebhooks();
      setSelectedId((current) => (current === webhook.id ? null : current));
      setCredential((current) => (current?.webhookId === webhook.id ? null : current));
    } catch (err) {
      setRowError(errorMessage(err, "Não foi possível apagar o webhook"));
    } finally {
      setPending(null);
      setConfirmingDeleteId(null);
    }
  }

  const isOwner = me?.isDeploymentOwner ?? false;

  return (
    <div>
      <div className="qb-dash__subhead">
        <button type="button" onClick={onBack} aria-label="Voltar aos ajustes">
          <Icon name="chevronLeft" size={17} />
        </button>
        <span>Webhooks</span>
        <button type="button" onClick={onClose} aria-label="Fechar webhooks">
          <Icon name="chevronRight" size={18} />
        </button>
      </div>

      <p
        role="status"
        aria-live="polite"
        className="min-h-[1.1em] text-[12.5px] text-[var(--qb-accent)]"
      >
        {copyStatus}
      </p>

      <SectionTitle>URL pública</SectionTitle>
      <PublicUrlSection
        isOwner={isOwner}
        publicUrl={publicUrl}
        input={publicUrlInput}
        onInputChange={setPublicUrlInput}
        saving={urlSaving}
        error={urlError ?? settingsError}
        onSave={() => void saveUrl()}
        onClear={() => void clearUrl()}
      />

      <SectionTitle>Webhooks de {bot.name}</SectionTitle>
      {webhooksError ? (
        <p role="alert" className="mb-2 text-[13px] text-[var(--qb-danger)]">
          {webhooksError}
        </p>
      ) : null}
      {rowError ? (
        <p role="alert" className="mb-2 text-[13px] text-[var(--qb-danger)]">
          {rowError}
        </p>
      ) : null}

      {webhooksLoading ? (
        <p className="text-[13px] text-[var(--qb-muted-2)]">Carregando…</p>
      ) : webhooks.length === 0 && !formOpen ? (
        <p className="text-[13px] leading-[1.45] text-[var(--qb-muted-2)]">
          Nenhum webhook ainda. Um webhook deixa um serviço de fora acordar {bot.name} com um evento
          HTTP.
        </p>
      ) : (
        <div className={CARD}>
          {webhooks.map((webhook, i) => (
            <WebhookRow
              key={webhook.id}
              webhook={webhook}
              divider={i > 0}
              selected={selected?.id === webhook.id}
              busy={pending?.webhookId === webhook.id ? pending.kind : null}
              confirmingDelete={confirmingDeleteId === webhook.id}
              confirmingRotate={confirmingRotateId === webhook.id}
              onSelect={() => setSelectedId(webhook.id)}
              onEdit={() => openEditForm(webhook)}
              onToggleActive={() => void toggleActive(webhook)}
              onTest={() => void runTest(webhook)}
              onAskDelete={() => setConfirmingDeleteId(webhook.id)}
              onCancelDelete={() => setConfirmingDeleteId(null)}
              onConfirmDelete={() => void confirmDelete(webhook)}
              onAskRotate={() => setConfirmingRotateId(webhook.id)}
              onCancelRotate={() => setConfirmingRotateId(null)}
              onConfirmRotate={() => void confirmRotate(webhook)}
            />
          ))}
        </div>
      )}

      {formOpen ? (
        <WebhookForm
          draft={draft}
          saving={saving}
          error={formError}
          onChange={setDraft}
          onCancel={() => setFormOpen(false)}
          onSubmit={() => void submitForm()}
        />
      ) : (
        <button type="button" onClick={openCreateForm} className="qb-dash__ghost-btn">
          + Adicionar webhook
        </button>
      )}

      {credential ? (
        <CredentialCard
          credential={credential.parts}
          onCopy={copyToClipboard}
          onDismiss={() => setCredential(null)}
        />
      ) : null}

      {selected ? (
        <>
          <SectionTitle>Endpoint</SectionTitle>
          <CredentialField
            label="Endpoint"
            value={webhookPublicEndpoint(publicUrl, selected.endpointId)}
            copyLabel={`Copiar endpoint salvo de ${selected.name}`}
            onCopy={() =>
              void copyToClipboard(
                "Endpoint",
                webhookPublicEndpoint(publicUrl, selected.endpointId),
              )
            }
          />
          <p className="mt-1.5 text-[12.5px] leading-[1.45] text-[var(--qb-muted-2)]">
            Este endereço não inclui o segredo. O segredo só aparece na criação ou ao girar.
          </p>
          <ActivitySection
            webhook={selected}
            attempts={attempts}
            loading={attemptsLoading}
            error={attemptsError}
            onRefresh={() => setAttemptsVersion((v) => v + 1)}
            onOpenRun={onOpenRun}
          />
        </>
      ) : null}
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mt-7 mb-2 px-1 text-[12.5px] tracking-[.06em] text-[var(--qb-muted-2)] uppercase">
      {children}
    </div>
  );
}

function PublicUrlSection({
  isOwner,
  publicUrl,
  input,
  onInputChange,
  saving,
  error,
  onSave,
  onClear,
}: {
  isOwner: boolean;
  publicUrl: string | null;
  input: string;
  onInputChange: (value: string) => void;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onClear: () => void;
}) {
  return (
    <div>
      {isOwner ? (
        <>
          <label className="qb-dash__field" htmlFor="webhook-public-url">
            URL pública
            <input
              id="webhook-public-url"
              value={input}
              placeholder="https://seu-dominio.com"
              disabled={saving}
              onChange={(e) => onInputChange(e.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </label>
          {error ? (
            <p role="alert" className="mt-1.5 text-[13px] text-[var(--qb-danger)]">
              {error}
            </p>
          ) : null}
          <div className="mt-2.5 flex items-center gap-3">
            <button type="button" disabled={saving} onClick={onSave} className="qb-dash__ghost-btn">
              {saving ? "Salvando…" : "Salvar URL"}
            </button>
            {publicUrl ? (
              <button
                type="button"
                disabled={saving}
                onClick={onClear}
                aria-label="Remover URL pública"
                className="text-[14px] text-[var(--qb-muted-2)] disabled:opacity-40"
              >
                Remover URL
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <p className="text-[13px] leading-[1.45] text-[var(--qb-muted-2)]">
          {publicUrl
            ? `URL pública configurada: ${publicUrl}.`
            : "Nenhuma URL pública configurada ainda."}{" "}
          Só quem instalou o Quibt neste computador pode mudar isso.
          {error ? (
            <span role="alert" className="mt-1 block text-[var(--qb-danger)]">
              {error}
            </span>
          ) : null}
        </p>
      )}
      <p className="mt-2.5 text-[12.5px] leading-[1.5] text-[var(--qb-muted-2)]">
        Numa VPS, use o domínio público da própria instalação. No PC, configure você mesmo um
        Cloudflare Tunnel ou um Tailscale Funnel apontando para http://127.0.0.1:5173 — e, se for
        pago, é você quem paga direto ao provedor. O mesmo endereço alimenta o QR em Ajustes →
        Celular → Qualquer rede. O Quibt não fornece, não hospeda e não vende Cloud, relay ou túnel.
      </p>
    </div>
  );
}

function WebhookRow({
  webhook,
  divider,
  selected,
  busy,
  confirmingDelete,
  confirmingRotate,
  onSelect,
  onEdit,
  onToggleActive,
  onTest,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
  onAskRotate,
  onCancelRotate,
  onConfirmRotate,
}: {
  webhook: Webhook;
  divider: boolean;
  selected: boolean;
  busy: "pause" | "delete" | "rotate" | "test" | null;
  confirmingDelete: boolean;
  confirmingRotate: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onToggleActive: () => void;
  onTest: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onAskRotate: () => void;
  onCancelRotate: () => void;
  onConfirmRotate: () => void;
}) {
  const disabled = busy !== null;
  return (
    <div
      className="px-3.5 py-3"
      style={divider ? { borderTop: "1px solid var(--qb-hairline)" } : undefined}
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          className="min-w-0 flex-1 text-left"
        >
          <span className="block truncate text-[15px] text-[var(--qb-ink)]">{webhook.name}</span>
          <span className="block text-[12.5px] text-[var(--qb-muted-2)]">
            {webhookActiveLabel(webhook.active)} · {webhook.deliveryCount}{" "}
            {webhook.deliveryCount === 1 ? "entrega" : "entregas"}
          </span>
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={onEdit}
          aria-label={`Editar ${webhook.name}`}
          className="text-[13.5px] text-[var(--qb-muted-2)] disabled:opacity-40"
        >
          Editar
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={onToggleActive}
          aria-label={`${webhook.active ? "Pausar" : "Ativar"} ${webhook.name}`}
          className="text-[13.5px] text-[var(--qb-accent)] disabled:opacity-40"
        >
          {busy === "pause" ? "…" : webhook.active ? "Pausar" : "Ativar"}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={onTest}
          aria-label={`Testar ${webhook.name}`}
          className="text-[13.5px] text-[var(--qb-accent)] disabled:opacity-40"
        >
          {busy === "test" ? "Testando…" : "Testar"}
        </button>
      </div>

      {confirmingRotate ? (
        <div className="mt-2.5 rounded-[var(--qb-r-md)] border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] px-3 py-2.5">
          <p className="text-[13px] leading-[1.4] text-[var(--qb-muted)]">
            Girar o segredo invalida o segredo atual na hora. Quem envia o webhook precisa da
            credencial nova.
          </p>
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              disabled={disabled}
              onClick={onCancelRotate}
              className="text-[13.5px] text-[var(--qb-muted-2)] disabled:opacity-40"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={onConfirmRotate}
              aria-label={`Confirmar giro de segredo de ${webhook.name}`}
              className="rounded-full bg-[var(--qb-ink-strong)] px-3 py-1 text-[13.5px] font-semibold text-[var(--qb-canvas)] disabled:opacity-40"
            >
              {busy === "rotate" ? "Girando…" : "Girar segredo"}
            </button>
          </div>
        </div>
      ) : confirmingDelete ? (
        <div className="mt-2.5 rounded-[var(--qb-r-md)] border border-[#F0D1CF] bg-[#FFF3F2] px-3 py-2.5">
          <p className="text-[13px] leading-[1.4] text-[#4A3030]">
            Apaga {webhook.name} de vez. Trabalho em andamento ou que ele já tenha disparado é
            cancelado.
          </p>
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              disabled={disabled}
              onClick={onCancelDelete}
              className="text-[13.5px] text-[var(--qb-muted-2)] disabled:opacity-40"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={onConfirmDelete}
              aria-label={`Confirmar apagar ${webhook.name}`}
              className="rounded-full bg-[var(--qb-danger)] px-3 py-1 text-[13.5px] font-semibold text-[var(--qb-canvas)] disabled:opacity-40"
            >
              {busy === "delete" ? "Apagando…" : "Apagar"}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-4">
          <button
            type="button"
            disabled={disabled}
            onClick={onAskRotate}
            aria-label={`Girar segredo de ${webhook.name}`}
            className="text-[12.5px] text-[var(--qb-muted-2)] disabled:opacity-40"
          >
            Girar segredo
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={onAskDelete}
            aria-label={`Apagar ${webhook.name}`}
            className="text-[12.5px] text-[var(--qb-danger)] disabled:opacity-40"
          >
            Apagar
          </button>
        </div>
      )}
    </div>
  );
}

function WebhookForm({
  draft,
  saving,
  error,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: WebhookDraft;
  saving: boolean;
  error: string | null;
  onChange: (draft: WebhookDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const editing = draft.webhookId !== null;
  return (
    <div className="mt-3 rounded-[var(--qb-r-md)] border border-[var(--qb-hairline)] bg-[var(--qb-canvas)] px-3.5 py-3.5">
      <label className="qb-dash__field" htmlFor="webhook-name">
        Nome
        <input
          id="webhook-name"
          value={draft.name}
          placeholder="Ex.: Chamados abertos"
          disabled={saving}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
        />
      </label>
      <label className="qb-dash__field" htmlFor="webhook-prompt">
        Instrução (opcional)
        <textarea
          id="webhook-prompt"
          rows={3}
          value={draft.prompt}
          placeholder="O que o bot deve fazer quando este evento chegar? Deixe vazio para um resumo padrão."
          disabled={saving}
          onChange={(e) => onChange({ ...draft, prompt: e.target.value })}
        />
      </label>
      <label className="qb-dash__field" htmlFor="webhook-events">
        Eventos aceitos (opcional, separados por vírgula)
        <input
          id="webhook-events"
          value={draft.eventsText}
          placeholder="push, pull_request"
          disabled={saving}
          onChange={(e) => onChange({ ...draft, eventsText: e.target.value })}
        />
      </label>
      <p className="mt-1 text-[12px] leading-[1.4] text-[var(--qb-muted-2)]">
        Vazio aceita qualquer evento. Preenchido, só os eventos listados acordam o bot.
      </p>
      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-[var(--qb-danger)]">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={saving}
          onClick={onCancel}
          className="text-[14.5px] text-[var(--qb-muted-2)] disabled:opacity-40"
        >
          Cancelar
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={onSubmit}
          className="rounded-full bg-[var(--qb-ink-strong)] px-4 py-2 text-[14.5px] font-semibold text-[var(--qb-canvas)] disabled:opacity-40"
        >
          {saving ? "Salvando…" : editing ? "Salvar webhook" : "Criar webhook"}
        </button>
      </div>
    </div>
  );
}

function CredentialCard({
  credential,
  onCopy,
  onDismiss,
}: {
  credential: WebhookCredential;
  onCopy: (label: string, value: string) => void;
  onDismiss: () => void;
}) {
  const curl = webhookCurl(credential);
  return (
    <div className="mt-3 rounded-[var(--qb-r-md)] border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] px-3.5 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] leading-[1.4] text-[var(--qb-ink)]">
          Guarde o segredo agora — ele só aparece esta vez. Fechando este cartão ou recarregando a
          página, ele desaparece; girar o segredo mostra um novo.
        </p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Ocultar credencial"
          className="shrink-0 text-[13px] text-[var(--qb-muted-2)]"
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      <CredentialField
        label="Endpoint"
        value={credential.endpointUrl}
        onCopy={() => onCopy("Endpoint", credential.endpointUrl)}
      />
      <CredentialField
        label="Segredo"
        value={credential.secret}
        onCopy={() => onCopy("Segredo", credential.secret)}
      />
      <CredentialField
        label="URL privada"
        value={credential.url}
        onCopy={() => onCopy("URL privada", credential.url)}
      />
      <CredentialField label="curl" value={curl} onCopy={() => onCopy("Comando curl", curl)} />
    </div>
  );
}

function CredentialField({
  label,
  value,
  copyLabel,
  onCopy,
}: {
  label: string;
  value: string;
  copyLabel?: string;
  onCopy: () => void;
}) {
  return (
    <div className="mt-2.5">
      <div className="mb-1 text-[12px] text-[var(--qb-muted-2)]">{label}</div>
      <div className="flex items-center gap-2">
        <code className="rk-mono min-w-0 flex-1 truncate rounded-[var(--qb-r-sm)] bg-[var(--qb-canvas)] px-2.5 py-1.5 text-[12.5px] text-[var(--qb-ink)]">
          {value}
        </code>
        <button
          type="button"
          onClick={onCopy}
          aria-label={copyLabel ?? `Copiar ${label.toLowerCase()}`}
          className="shrink-0 rounded-[var(--qb-r-sm)] p-1.5 text-[var(--qb-muted-2)] hover:bg-[var(--qb-canvas)] hover:text-[var(--qb-ink)]"
        >
          <Icon name="copy" size={14} />
        </button>
      </div>
    </div>
  );
}

const OUTCOME_BADGE_CLASS: Record<WebhookAttempt["outcome"], string> = {
  accepted: "bg-[rgba(44,138,75,.12)] text-[#2C8A4B]",
  duplicate: "bg-[var(--qb-surface-2)] text-[var(--qb-muted)]",
  ignored: "bg-[var(--qb-surface-2)] text-[var(--qb-muted)]",
  rejected: "bg-[var(--qb-danger-soft)] text-[var(--qb-danger)]",
};

function ActivitySection({
  webhook,
  attempts,
  loading,
  error,
  onRefresh,
  onOpenRun,
}: {
  webhook: Webhook;
  attempts: WebhookAttempt[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onOpenRun: (runId: string) => void;
}) {
  return (
    <div>
      <div className="mt-7 mb-2 flex items-baseline justify-between gap-3 px-1">
        <span className="text-[12.5px] tracking-[.06em] text-[var(--qb-muted-2)] uppercase">
          Atividade de {webhook.name}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="text-[12.5px] text-[var(--qb-accent)] disabled:opacity-40"
        >
          {loading ? "Atualizando…" : "Atualizar"}
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-[13px] text-[var(--qb-danger)]">
          {error}
        </p>
      ) : null}
      {!loading && attempts.length === 0 && !error ? (
        <p className="text-[13px] text-[var(--qb-muted-2)]">
          Nenhuma entrega ainda. Use "Testar" para enviar um evento de exemplo.
        </p>
      ) : (
        <div className={CARD}>
          {attempts.map((attempt, i) => {
            const runId = attempt.runId;
            return (
              <div
                key={attempt.id}
                className="px-3.5 py-2.5"
                style={i > 0 ? { borderTop: "1px solid var(--qb-hairline)" } : undefined}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-[var(--qb-r-xs)] px-2 py-0.5 text-[11.5px] font-semibold ${OUTCOME_BADGE_CLASS[attempt.outcome]}`}
                  >
                    {webhookOutcomeLabel(attempt.outcome)}
                  </span>
                  <span className="text-[12px] text-[var(--qb-muted-2)]">
                    {inboxTimeLabel(attempt.receivedAt) ?? attempt.receivedAt}
                  </span>
                  {attempt.eventName ? (
                    <span className="text-[12px] text-[var(--qb-muted-2)]">
                      · {attempt.eventName}
                    </span>
                  ) : null}
                </div>
                {attempt.reason ? (
                  <div className="mt-1 text-[12.5px] text-[var(--qb-muted)]">{attempt.reason}</div>
                ) : null}
                {attempt.preview ? (
                  <div className="mt-1 truncate text-[12.5px] text-[var(--qb-muted)]">
                    {attempt.preview}
                  </div>
                ) : null}
                {runId ? (
                  <button
                    type="button"
                    onClick={() => onOpenRun(runId)}
                    className="mt-1.5 text-[12.5px] text-[var(--qb-accent)]"
                  >
                    Abrir no chat
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
