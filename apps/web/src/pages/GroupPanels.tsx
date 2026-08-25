import type { Bot, BotGroup, Routine } from "@quibt/contracts";
import { formatCron } from "@quibt/core";
import { BotAvatar, Switch } from "@quibt/ui-web";
import { useEffect, useRef, useState } from "react";
import { GroupAvatar } from "./GroupAvatar";

export function NewGroupForm({
  bots,
  onCreate,
  onCancel,
  error,
  onPlans,
}: {
  bots: Bot[];
  onCreate: (input: { name: string; botIds: string[] }) => void;
  onCancel: () => void;
  error?: string | null;
  onPlans?: () => void;
}) {
  const [name, setName] = useState("");
  const [botIds, setBotIds] = useState<string[]>([]);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  function toggle(id: string) {
    setBotIds((ids) => (ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id]));
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13px] text-[var(--qb-muted)]">Novo grupo</span>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Fechar"
          className="grid h-7 w-7 place-items-center rounded-full bg-[var(--qb-surface)] text-[13px] text-[var(--qb-muted)]"
        >
          ✕
        </button>
      </div>
      <label className="mt-6 block text-[13px] text-[var(--qb-muted)]">
        Nome
        <input
          ref={nameRef}
          autoComplete="off"
          name="group-name"
          aria-label="Nome do grupo"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Dê um nome a este grupo"
          className="mt-2 w-full rounded-[var(--qb-r-md)] border border-[var(--qb-hairline)] bg-[var(--qb-canvas)] px-3.5 py-3 text-[17px] text-[var(--qb-ink)] outline-none placeholder:text-[var(--qb-muted)]"
        />
      </label>
      <div className="mt-5 text-[13px] text-[var(--qb-muted)]">Bots neste grupo</div>
      <div className="mt-2 overflow-hidden rounded-[var(--qb-r-lg)] border border-[var(--qb-hairline)] bg-[var(--qb-canvas)]">
        {bots.map((bot, i) => (
          <label
            key={bot.id}
            className="flex cursor-pointer items-center gap-3 px-3.5 py-3"
            style={i > 0 ? { borderTop: "1px solid var(--qb-hairline)" } : undefined}
          >
            <input
              type="checkbox"
              checked={botIds.includes(bot.id)}
              onChange={() => toggle(bot.id)}
              className="h-4 w-4 accent-[var(--qb-accent)]"
            />
            <BotAvatar color={bot.color} shape={bot.shape} size={28} />
            <span className="flex-1 truncate text-[17px] text-[var(--qb-ink)]">{bot.name}</span>
          </label>
        ))}
        {bots.length === 0 ? (
          <p className="px-3.5 py-3 text-[15px] text-[var(--qb-muted)]">Crie um bot primeiro.</p>
        ) : null}
      </div>
      {error ? (
        <p className="mt-4 text-[13px] text-[var(--qb-danger)]">
          {error}{" "}
          {onPlans ? (
            <button type="button" onClick={onPlans} className="font-semibold text-[#8F1712]">
              Ver planos
            </button>
          ) : null}
        </p>
      ) : null}
      <button
        type="button"
        disabled={!name.trim()}
        onClick={() => onCreate({ name: name.trim(), botIds })}
        className="mt-5 rounded-[var(--qb-r-md)] bg-[var(--qb-ink-strong)] px-5 py-2.5 font-semibold text-[var(--qb-canvas)] disabled:opacity-40"
      >
        Criar grupo
      </button>
    </div>
  );
}

export function GroupMembersPane({
  group,
  bots,
  routines,
  onRename,
  onSaveInstructions,
  onAddMember,
  onRemoveMember,
  onAddRoutine,
  onToggleRoutine,
  onRemoveRoutine,
  onDelete,
  onClose,
}: {
  group: BotGroup;
  bots: Bot[];
  routines: Routine[];
  onRename: (name: string) => Promise<void>;
  onSaveInstructions: (instructions: string) => Promise<void>;
  onAddMember: (botId: string) => Promise<void>;
  onRemoveMember: (botId: string) => Promise<void>;
  onAddRoutine: () => void;
  onToggleRoutine: (routine: Routine, active: boolean) => Promise<void>;
  onRemoveRoutine: (routine: Routine) => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(group.name);
  const [instructions, setInstructions] = useState(group.instructions);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const outside = bots.filter((bot) => !group.members.some((member) => member.id === bot.id));

  function run(action: () => Promise<void>) {
    setError(null);
    void action().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : "Algo deu errado");
    });
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13px] text-[var(--qb-muted)]">
          {group.members.length} {group.members.length === 1 ? "membro" : "membros"}
        </span>
        <button
          type="button"
          aria-label="Fechar"
          onClick={onClose}
          className="grid h-7 w-7 place-items-center rounded-full bg-[var(--qb-surface)] text-[13px] text-[var(--qb-muted)]"
        >
          ✕
        </button>
      </div>
      <div className="mb-5 flex justify-center">
        <GroupAvatar members={group.members} size={96} />
      </div>
      <label className="block text-[13px] text-[var(--qb-muted)]">
        Nome do grupo
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-2 w-full rounded-[var(--qb-r-md)] border border-[var(--qb-hairline)] bg-[var(--qb-canvas)] px-3.5 py-3 text-[17px] text-[var(--qb-ink)] outline-none"
        />
      </label>
      <button
        type="button"
        disabled={!name.trim() || name.trim() === group.name}
        onClick={() => run(() => onRename(name.trim()))}
        className="mt-3 rounded-full bg-[var(--qb-ink-strong)] px-4 py-2 text-[14.5px] font-semibold text-[var(--qb-canvas)] disabled:opacity-40"
      >
        Salvar
      </button>

      <div className="mt-[30px] mb-2 text-[14px] text-[var(--qb-muted)]">Instruções</div>
      <button
        type="button"
        onClick={() => setInstructionsOpen((open) => !open)}
        className="flex w-full items-center gap-3 rounded-[var(--qb-r-md)] px-2.5 py-2.5 text-left hover:bg-[var(--qb-surface-2)]"
      >
        <span className="min-w-0 flex-1 truncate text-[14.5px] text-[var(--qb-ink)]">
          {group.instructions.trim() ? group.instructions : "Como este grupo deve trabalhar"}
        </span>
        <span className="text-[13px] text-[var(--qb-muted)]">{instructionsOpen ? "▴" : "▾"}</span>
      </button>
      {instructionsOpen ? (
        <div className="px-0.5">
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={6}
            placeholder="Ordens permanentes que todo bot deste grupo segue."
            className="mt-2 w-full rounded-[var(--qb-r-lg)] border border-[var(--qb-hairline)] bg-[var(--qb-canvas)] px-3.5 py-3 text-[15px] leading-[1.5] text-[var(--qb-ink)] outline-none"
          />
          <button
            type="button"
            disabled={savingInstructions || instructions === group.instructions}
            onClick={() => {
              setSavingInstructions(true);
              setError(null);
              void onSaveInstructions(instructions)
                .catch((err: unknown) => {
                  setError(err instanceof Error ? err.message : "Algo deu errado");
                })
                .finally(() => setSavingInstructions(false));
            }}
            className="mt-2 rounded-full bg-[var(--qb-ink-strong)] px-4 py-2 text-[14.5px] font-semibold text-[var(--qb-canvas)] disabled:opacity-40"
          >
            {savingInstructions ? "Salvando…" : "Salvar"}
          </button>
        </div>
      ) : null}

      <div className="mt-[30px] mb-2 text-[14px] text-[var(--qb-muted)]">Rotinas</div>
      {routines.map((routine) => (
        <div
          key={routine.id}
          className="flex items-center gap-3 rounded-[var(--qb-r-md)] px-2.5 py-2.5 hover:bg-[var(--qb-surface-2)]"
        >
          <span className="text-[#E65707]">◷</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14.5px] text-[var(--qb-ink)]">
              {routine.name}
            </span>
            <span className="block text-[13px] text-[var(--qb-muted)]">
              {formatCron(routine.cron)}
            </span>
          </span>
          <Switch
            checked={routine.active}
            onCheckedChange={(active) => run(() => onToggleRoutine(routine, active))}
          />
          <button
            type="button"
            onClick={() => run(() => onRemoveRoutine(routine))}
            className="text-[13.5px] text-[var(--qb-muted)] hover:text-[#E65707]"
          >
            Remover
          </button>
        </div>
      ))}
      {routines.length === 0 ? (
        <p className="px-2.5 text-[13.5px] text-[var(--qb-muted)]">Nenhuma rotina ainda</p>
      ) : null}
      <button
        type="button"
        onClick={onAddRoutine}
        className="mt-1 px-2.5 py-2 text-[14.5px] text-[var(--qb-muted)] hover:text-[var(--qb-ink)]"
      >
        + Adicionar rotina
      </button>

      <div className="mt-[30px] mb-2 text-[14px] text-[var(--qb-muted)]">Membros</div>
      {group.members.map((member) => (
        <div
          key={member.id}
          className="flex items-center gap-3 rounded-[var(--qb-r-md)] px-2.5 py-2.5 hover:bg-[var(--qb-surface-2)]"
        >
          <BotAvatar color={member.color} shape={member.shape} size={28} />
          <span className="flex-1 truncate text-[14.5px] text-[var(--qb-ink)]">{member.name}</span>
          <button
            type="button"
            onClick={() => run(() => onRemoveMember(member.id))}
            className="text-[13.5px] text-[var(--qb-muted)] hover:text-[#E65707]"
          >
            Remover
          </button>
        </div>
      ))}
      {group.members.length === 0 ? (
        <p className="px-2.5 text-[13.5px] text-[var(--qb-muted)]">Nenhum bot neste grupo ainda.</p>
      ) : null}

      <div className="mt-[26px] mb-2 text-[14px] text-[var(--qb-muted)]">Adicionar um bot</div>
      {outside.map((bot) => (
        <div
          key={bot.id}
          className="flex items-center gap-3 rounded-[var(--qb-r-md)] px-2.5 py-2.5 hover:bg-[var(--qb-surface-2)]"
        >
          <BotAvatar color={bot.color} shape={bot.shape} size={28} />
          <span className="flex-1 truncate text-[14.5px] text-[var(--qb-ink)]">{bot.name}</span>
          <button
            type="button"
            onClick={() => run(() => onAddMember(bot.id))}
            className="text-[13.5px] text-[var(--qb-muted)] hover:text-[var(--qb-ink)]"
          >
            Adicionar
          </button>
        </div>
      ))}
      {outside.length === 0 ? (
        <p className="px-2.5 text-[13.5px] text-[var(--qb-muted)]">
          Todos os bots já estão neste grupo.
        </p>
      ) : null}

      <div className="mt-6">
        {confirming ? (
          <div className="w-full rounded-[var(--qb-r-md)] border border-[#F0C3BF] bg-[#FFF2F0] px-3.5 py-3">
            <p className="text-[13.5px] leading-[1.45] text-[#6B2A25]">
              Isso apaga {group.name} e o fio do grupo. Os bots em si continuam.
            </p>
            <div className="mt-3 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="text-[14px] text-[var(--qb-muted)]"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => run(onDelete)}
                className="rounded-full bg-[var(--qb-danger)] px-3.5 py-1.5 text-[14.5px] font-semibold text-[var(--qb-canvas)]"
              >
                Apagar
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="text-[15px] text-[var(--qb-danger)]"
          >
            Apagar grupo
          </button>
        )}
      </div>
      {error ? <p className="mt-2 text-[13px] text-[#E65707]">{error}</p> : null}
    </div>
  );
}
