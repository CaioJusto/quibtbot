import type { Bot, MemoryDocument, Routine } from "@quibt/contracts";
import {
  formatCron,
  formatMemoryUsageFromRaw,
  MEMORY_CHAR_LIMIT,
  memoryCharCount,
  parseMemoryEntries,
  USER_CHAR_LIMIT,
} from "@quibt/core";
import { type Appearance, formatAppearance, resolveAppearance } from "@quibt/ui-tokens";
import { BotAvatar, CharacterPicker, Switch } from "@quibt/ui-web";
import { type ReactNode, useEffect, useState } from "react";
import { Icon } from "../components/desktop-ui";
import { memoryLabel, splitMemoryDocs } from "../lib/memory-panel";
import { rpc } from "../lib/rpc";

const CARD =
  "overflow-hidden rounded-[var(--qb-r-md)] border border-[var(--qb-hairline)] bg-[var(--qb-canvas)]";

export type AgentPatch = {
  name?: string;
  title?: string;
  description?: string;
  instructions?: string;
  color?: string;
  shape?: string;
  notifyOnFinish?: boolean;
  autoApprove?: boolean;
  chiefOfStaff?: boolean;
  voiceEnabled?: boolean;
  voiceAutoSpeak?: boolean;
  voiceId?: string;
};

export function AgentSettings({
  bot,
  routines,
  voiceConfigured,
  onSave,
  onOpenInstructions,
  onOpenMemory,
  onOpenWebhooks,
  onOpenRoutine,
  onAddRoutine,
  onRunNow,
  onExport,
  onClear,
  onDelete,
  onBack,
  onClose,
}: {
  bot: Bot;
  routines: Routine[];
  /** Há login ChatGPT/Codex na conta? Sem ele os toggles avisam onde conectar. */
  voiceConfigured?: boolean;
  onSave: (patch: AgentPatch) => Promise<void>;
  onOpenInstructions: () => void;
  onOpenMemory: () => void;
  onOpenWebhooks: () => void;
  onOpenRoutine: (routine: Routine) => void;
  onAddRoutine: () => void;
  onRunNow?: () => Promise<void>;
  onExport: () => Promise<void>;
  onClear: () => Promise<void>;
  onDelete: () => Promise<void>;
  onBack: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(bot.name);
  const [title, setTitle] = useState(bot.title);
  const [description, setDescription] = useState(bot.description ?? "");
  const [appearance, setAppearance] = useState<Appearance>(resolveAppearance(bot.color, bot.shape));
  const [notify, setNotify] = useState(bot.notifyOnFinish);
  const [autoApprove, setAutoApprove] = useState(bot.autoApprove !== false);
  const [voiceOn, setVoiceOn] = useState(bot.voiceEnabled === true);
  const [autoSpeak, setAutoSpeak] = useState(bot.voiceAutoSpeak === true);
  const [voiceId, setVoiceId] = useState(bot.voiceId ?? "");
  const [confirming, setConfirming] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appearanceOpen, setAppearanceOpen] = useState(false);

  const dirty =
    name.trim() !== bot.name || title !== bot.title || description !== (bot.description ?? "");

  function applyAppearance(next: Appearance) {
    setAppearance(next);
    // The shape rides along inside `color` — no schema change needed to persist it.
    void onSave({ color: formatAppearance(next), shape: next.shape }).catch(() => undefined);
  }

  return (
    <div>
      <div className="qb-dash__subhead">
        <button type="button" onClick={onBack} aria-label="Voltar ao computador">
          <Icon name="chevronLeft" size={17} />
        </button>
        <span>Ajustes</span>
        <button type="button" onClick={onClose} aria-label="Fechar ajustes">
          <Icon name="chevronRight" size={18} />
        </button>
      </div>

      <div className="qb-dash__settings-avatar">
        <button
          type="button"
          aria-label="Editar personagem"
          aria-expanded={appearanceOpen}
          onClick={() => setAppearanceOpen((open) => !open)}
        >
          <BotAvatar color={appearance.color} shape={appearance.shape} size={64} title={bot.name} />
        </button>
        {appearanceOpen ? (
          <div className="qb-dash__character-popover">
            <CharacterPicker
              color={appearance.color}
              shape={appearance.shape}
              onChange={applyAppearance}
            />
            <p className="mt-2 px-1 text-[12.5px] leading-[1.4] text-[var(--qb-muted-2)]">
              Escolha como este bot aparece no Quibt.
            </p>
          </div>
        ) : null}
      </div>
      <label className="qb-dash__field">
        Nome
        <input
          value={name}
          placeholder="Dê um nome a este bot"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="qb-dash__field">
        Cargo
        <input
          value={title}
          placeholder="Descreva o que este bot faz"
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="qb-dash__field">
        Descrição
        <textarea
          rows={4}
          value={description}
          placeholder="Pra que serve este bot"
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      {dirty ? (
        <button
          type="button"
          onClick={() =>
            void onSave({
              name: name.trim() || bot.name,
              title,
              description,
            })
          }
          className="qb-dash__ghost-btn"
        >
          Salvar
        </button>
      ) : null}

      <div className="qb-dash__toggle-card">
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-medium text-[var(--qb-ink)]">Notificações</span>
          <span className="mt-0.5 block text-[12px] leading-[1.35] text-[var(--qb-muted)]">
            Avisar quando este bot terminar ou precisar de você
          </span>
        </span>
        <Switch
          className="qb-grok-switch"
          checked={notify}
          onCheckedChange={(next) => {
            setNotify(next);
            void onSave({ notifyOnFinish: next }).catch(() => setNotify(!next));
          }}
        />
      </div>

      <div className="qb-dash__toggle-card">
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-medium text-[var(--qb-ink)]">Voz</span>
          <span className="mt-0.5 block text-[12px] leading-[1.35] text-[var(--qb-muted)]">
            {voiceConfigured
              ? "Ouvir as respostas deste bot em voz alta"
              : "Entre com ChatGPT Plus/Pro em Modelos para ouvir as respostas"}
          </span>
        </span>
        <Switch
          className="qb-grok-switch"
          checked={voiceOn}
          onCheckedChange={(next) => {
            setVoiceOn(next);
            void onSave({ voiceEnabled: next }).catch(() => setVoiceOn(!next));
          }}
        />
      </div>
      {voiceOn ? (
        <>
          <div className="qb-dash__toggle-card">
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-medium text-[var(--qb-ink)]">
                Falar respostas
              </span>
              <span className="mt-0.5 block text-[12px] leading-[1.35] text-[var(--qb-muted)]">
                Ler em voz alta cada resposta nova, sem apertar nada
              </span>
            </span>
            <Switch
              className="qb-grok-switch"
              checked={autoSpeak}
              onCheckedChange={(next) => {
                setAutoSpeak(next);
                void onSave({ voiceAutoSpeak: next }).catch(() => setAutoSpeak(!next));
              }}
            />
          </div>
          <label className="qb-dash__field">
            Voz (opcional)
            <input
              value={voiceId}
              placeholder="alloy, coral, fable…; vazio usa alloy"
              onChange={(e) => setVoiceId(e.target.value)}
              onBlur={() => {
                if ((bot.voiceId ?? "") === voiceId.trim()) return;
                void onSave({ voiceId: voiceId.trim() }).catch(() => setVoiceId(bot.voiceId ?? ""));
              }}
            />
          </label>
        </>
      ) : null}

      <details className="qb-dash__advanced">
        <summary>Mais opções</summary>

        <SectionTitle>Comportamento</SectionTitle>
        <div className={CARD}>
          <Row icon={<DocIcon />} label="Instruções" onClick={onOpenInstructions} />
          <Row icon={<MemoryIcon />} label="Memória" divider onClick={onOpenMemory} />
          <Row icon={<WebhookIcon />} label="Webhooks" divider onClick={onOpenWebhooks} />
        </div>

        <SectionTitle>Rotinas</SectionTitle>
        {routines.length ? (
          <div className={CARD}>
            {routines.map((routine, i) => (
              <Row
                key={routine.id}
                icon={<ClockIcon />}
                label={routine.name}
                detail={`${formatCron(routine.cron)}${routine.active ? "" : " · pausada"}`}
                divider={i > 0}
                onClick={() => onOpenRoutine(routine)}
              />
            ))}
          </div>
        ) : (
          <p className="text-[13px] leading-[1.45] text-[var(--qb-muted-2)]">
            Rotinas rodam {bot.name} no horário, mesmo quando você não está.
          </p>
        )}
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={onAddRoutine}
            className="mt-2.5 px-1 py-2 text-[15px] text-[var(--qb-accent)]"
          >
            + Adicionar rotina
            <span className="sr-only">+ Nova rotina</span>
          </button>
          {onRunNow && routines.length ? (
            <button
              type="button"
              onClick={() => void onRunNow()}
              className="mt-2.5 px-1 py-2 text-[15px] text-[var(--qb-muted-2)]"
            >
              Rodar agora
            </button>
          ) : null}
        </div>

        <SectionTitle>Aprovações</SectionTitle>
        <div className={`${CARD} flex items-center gap-3 px-3.5 py-3`}>
          <span className="flex-1">
            <span className="block text-[15px] text-[var(--qb-ink)]">Aprovar sozinho</span>
            <span className="block text-[12.5px] text-[var(--qb-muted-2)]">
              Ele age sem parar para perguntar
            </span>
          </span>
          <Switch
            checked={autoApprove}
            onCheckedChange={(next) => {
              setAutoApprove(next);
              void onSave({ autoApprove: next }).catch(() => setAutoApprove(!next));
            }}
          />
        </div>
        <p className="mt-2 px-1 text-[13px] leading-[1.4] text-[var(--qb-muted-2)]">
          Ligado, ele age sozinho e só para em comando perigoso, senha e criar ou apagar bot.
          Desligado, pede aprovação para quase tudo. No card de aprovação, “Sempre permitir” libera
          só aquele comando, exatamente como está escrito, daí em diante.
        </p>

        <div className="mt-8 flex flex-col items-start gap-3">
          <button
            type="button"
            onClick={() => void onExport()}
            className="text-[15px] text-[var(--qb-accent)]"
          >
            Exportar
          </button>
          {confirmingClear ? (
            <div className="w-full rounded-[var(--qb-r-md)] border border-[#F0D1CF] bg-[#FFF3F2] px-3.5 py-3">
              <p className="text-[13.5px] leading-[1.45] text-[#4A3030]">
                Isso apaga as mensagens desta conversa e para o trabalho atual. O bot, o computador,
                a memória e as rotinas ficam.
              </p>
              <div className="mt-3 flex items-center gap-3">
                <button
                  type="button"
                  disabled={clearing}
                  onClick={() => {
                    setConfirmingClear(false);
                    setError(null);
                  }}
                  className="text-[15px] text-[var(--qb-muted-2)] disabled:opacity-40"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={clearing}
                  onClick={() => {
                    setClearing(true);
                    setError(null);
                    void onClear()
                      .then(() => {
                        setConfirmingClear(false);
                        setClearing(false);
                      })
                      .catch((err: unknown) => {
                        setError(
                          err instanceof Error ? err.message : "Não foi possível limpar a conversa",
                        );
                        setClearing(false);
                      });
                  }}
                  className="rounded-full bg-[var(--qb-danger)] px-3.5 py-1.5 text-[14.5px] font-semibold text-[var(--qb-canvas)] disabled:opacity-40"
                >
                  {clearing ? "Limpando…" : "Limpar"}
                </button>
              </div>
              {error ? <p className="mt-2 text-[13px] text-[var(--qb-danger)]">{error}</p> : null}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                setConfirmingClear(true);
              }}
              className="text-[15px] text-[#FF9F0A]"
            >
              Limpar conversa
            </button>
          )}
          {confirming ? (
            <div className="w-full rounded-[var(--qb-r-md)] border border-[#F0D1CF] bg-[#FFF3F2] px-3.5 py-3">
              <p className="text-[13.5px] leading-[1.45] text-[#4A3030]">
                Isso apaga {bot.name} de vez, incluindo o fio, o computador, a memória e as rotinas.
              </p>
              <div className="mt-3 flex items-center gap-3">
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => {
                    setConfirming(false);
                    setError(null);
                  }}
                  className="text-[15px] text-[var(--qb-muted-2)] disabled:opacity-40"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => {
                    setDeleting(true);
                    setError(null);
                    void onDelete().catch((err: unknown) => {
                      setError(
                        err instanceof Error ? err.message : "Não foi possível apagar o bot",
                      );
                      setDeleting(false);
                    });
                  }}
                  className="rounded-full bg-[var(--qb-danger)] px-3.5 py-1.5 text-[14.5px] font-semibold text-[var(--qb-canvas)] disabled:opacity-40"
                >
                  {deleting ? "Apagando…" : "Apagar"}
                </button>
              </div>
              {error ? <p className="mt-2 text-[13px] text-[var(--qb-danger)]">{error}</p> : null}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setConfirmingClear(false);
                setConfirming(true);
              }}
              className="text-[15px] text-[var(--qb-danger)]"
            >
              Apagar bot
            </button>
          )}
        </div>
      </details>
    </div>
  );
}

export function MemoryPanel({ bot, onBack }: { bot: Bot; onBack: () => void }) {
  const [botText, setBotText] = useState("");
  const [userText, setUserText] = useState("");
  const [botDoc, setBotDoc] = useState<MemoryDocument | undefined>();
  const [userDoc, setUserDoc] = useState<MemoryDocument | undefined>();
  const [saving, setSaving] = useState<"bot" | "user" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      rpc.memory.list({ botId: bot.id, scope: "bot" }),
      rpc.memory.list({ scope: "user" }),
    ])
      .then(([botDocs, userDocs]) => {
        if (cancelled) return;
        const split = splitMemoryDocs([...botDocs, ...userDocs]);
        setBotDoc(split.bot);
        setUserDoc(split.user);
        setBotText(split.bot?.content ?? "");
        setUserText(split.user?.content ?? "");
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Não foi possível ler a memória");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [bot.id, bot.name]);

  async function save(scope: "bot" | "user") {
    const doc = scope === "bot" ? botDoc : userDoc;
    const text = scope === "bot" ? botText : userText;
    const limit = scope === "bot" ? MEMORY_CHAR_LIMIT : USER_CHAR_LIMIT;
    if (memoryCharCount(parseMemoryEntries(text)) > limit) {
      setError(
        `${scope === "bot" ? "MEMORY.md" : "USER.md"} passou de ${limit.toLocaleString("pt-BR")} caracteres. Consolide entradas (separadas por §) e tente de novo.`,
      );
      return;
    }
    if (!doc) {
      setError("Ainda não há um arquivo de memória para salvar.");
      return;
    }
    setSaving(scope);
    setError(null);
    try {
      const updated = await rpc.memory.update({
        documentId: doc.id,
        content: scope === "bot" ? botText : userText,
      });
      if (scope === "bot") setBotDoc(updated);
      else setUserDoc(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível salvar a memória");
    } finally {
      setSaving(null);
    }
  }

  return (
    <div>
      <PanelHeader title="Memória" onBack={onBack} />
      <p className="text-[13px] leading-[1.45] text-[var(--qb-muted-2)]">
        Memória no estilo Hermes: {bot.name} lê um snapshot no início do turno. MEMORY.md são as
        notas do agente ({MEMORY_CHAR_LIMIT.toLocaleString("pt-BR")} chars); USER.md é o perfil da
        conta ({USER_CHAR_LIMIT.toLocaleString("pt-BR")} chars). Separe entradas com §. O que você
        salvar aqui entra no próximo turno.
      </p>
      <MemoryEditor
        label={memoryLabel("bot")}
        usage={formatMemoryUsageFromRaw(botText, "memory")}
        value={botText}
        saving={saving === "bot"}
        onChange={setBotText}
        onSave={() => void save("bot")}
      />
      <MemoryEditor
        label={memoryLabel("user")}
        usage={formatMemoryUsageFromRaw(userText, "user")}
        value={userText}
        saving={saving === "user"}
        onChange={setUserText}
        onSave={() => void save("user")}
      />
      {error ? <p className="mt-2 text-[13px] text-[var(--qb-danger)]">{error}</p> : null}
    </div>
  );
}

function MemoryEditor({
  label,
  usage,
  value,
  saving,
  onChange,
  onSave,
}: {
  label: string;
  usage: string;
  value: string;
  saving: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="mt-4">
      <div className="mb-2 flex items-baseline justify-between gap-3 px-1">
        <div className="text-[12.5px] tracking-[.06em] text-[var(--qb-muted-2)] uppercase">
          {label}
        </div>
        <div className="text-[12px] text-[var(--qb-muted)]">{usage}</div>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={8}
        placeholder="Uma entrada por bloco, separadas por §"
        className="w-full rounded-[var(--qb-r-md)] border border-[var(--qb-hairline)] bg-[var(--qb-canvas)] px-3.5 py-3 text-[15px] leading-[1.5] text-[var(--qb-ink)] outline-none"
      />
      <button
        type="button"
        disabled={saving}
        onClick={onSave}
        className="mt-2 rounded-full bg-[var(--qb-ink-strong)] px-4 py-2 text-[14.5px] font-semibold text-[var(--qb-canvas)] disabled:opacity-40"
      >
        {saving ? "Salvando…" : "Salvar"}
      </button>
    </div>
  );
}

export function InstructionsPanel({
  bot,
  onBack,
  onSave,
}: {
  bot: Bot;
  onBack: () => void;
  onSave: (instructions: string) => Promise<void>;
}) {
  const [text, setText] = useState(bot.instructions || bot.description);
  const [saving, setSaving] = useState(false);

  return (
    <div>
      <PanelHeader title="Instruções" onBack={onBack} />
      <p className="text-[13px] leading-[1.45] text-[var(--qb-muted-2)]">
        Ordens permanentes que {bot.name} segue em toda execução.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={14}
        className="mt-3 w-full rounded-[var(--qb-r-md)] border border-[var(--qb-hairline)] bg-[var(--qb-canvas)] px-3.5 py-3 text-[15px] leading-[1.5] text-[var(--qb-ink)] outline-none"
      />
      <button
        type="button"
        disabled={saving}
        onClick={() => {
          setSaving(true);
          void onSave(text).finally(() => setSaving(false));
        }}
        className="mt-3 rounded-full bg-[var(--qb-ink-strong)] px-4 py-2 text-[14.5px] font-semibold text-[var(--qb-canvas)] disabled:opacity-40"
      >
        {saving ? "Salvando…" : "Salvar"}
      </button>
    </div>
  );
}

export function PanelHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="mb-4 flex items-center gap-3">
      <button
        type="button"
        onClick={onBack}
        aria-label="Voltar"
        className="grid h-7 w-7 place-items-center rounded-full bg-[var(--qb-surface)] text-[15px] text-[var(--qb-accent)]"
      >
        ‹
      </button>
      <span className="text-[16px] font-semibold text-[var(--qb-ink)]">{title}</span>
    </div>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <div className="mt-7 mb-2 px-1 text-[12.5px] tracking-[.06em] text-[var(--qb-muted-2)] uppercase">
      {children}
    </div>
  );
}

function Row({
  icon,
  label,
  detail,
  divider,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  divider?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-3.5 py-3 text-left"
      style={divider ? { borderTop: "1px solid var(--qb-hairline)" } : undefined}
    >
      <span className="text-[var(--qb-accent)]">{icon}</span>
      <span className="flex-1 truncate text-[15px] text-[var(--qb-ink)]">{label}</span>
      {detail ? <span className="text-[13.5px] text-[var(--qb-muted-2)]">{detail}</span> : null}
      <ChevronIcon />
    </button>
  );
}

function ClockIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5.2l3.2 2" />
    </svg>
  );
}

function MemoryIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3a6 6 0 0 0-6 6c0 2.2 1.2 4.1 3 5.2V17a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-2.8c1.8-1.1 3-3 3-5.2a6 6 0 0 0-6-6z" />
      <path d="M10 21h4" />
    </svg>
  );
}

function WebhookIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 17a4 4 0 1 1 2.3-7.3" />
      <circle cx="16" cy="6" r="2.5" />
      <circle cx="7" cy="17" r="2.5" />
      <circle cx="17" cy="17" r="2.5" />
      <path d="M14.7 7.7 9.5 15.5M15 14.5 8.7 10" />
    </svg>
  );
}

function DocIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--qb-muted)"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}
