import { WORKER_DOWN_MESSAGE, WORKER_HEARTBEAT_MS } from "@quibt/core";

/**
 * Uma linha no topo do chat quando `me.worker.alive` é falso: sem worker, mandar mensagem é
 * silêncio. `null` é "ainda não perguntei" e não mostra nada — o aviso só aparece com um não.
 */
export function WorkerDownNotice({ alive }: { alive: boolean | null }) {
  if (alive !== false) return null;
  return (
    <div
      role="alert"
      data-testid="worker-down"
      className="flex shrink-0 items-start gap-2 border-b border-[var(--qb-hairline)] bg-[var(--qb-danger-soft)] px-4 py-2 text-[var(--qb-t-sm)] text-[var(--qb-ink)]"
    >
      <span
        aria-hidden="true"
        className="mt-[0.4em] inline-block h-2 w-2 shrink-0 rounded-full bg-[var(--qb-danger)]"
      />
      {/* Nada de `truncate`: no celular a parte cortada seria justamente a que diz o que fazer. */}
      <span className="min-w-0 whitespace-normal">{WORKER_DOWN_MESSAGE}</span>
    </div>
  );
}

/**
 * Pega carona no poll que já existe: só pergunta `me` quando passou a cadência do batimento
 * desde a última resposta, então o aviso custa uma chamada a cada ~15 s, não a cada volta.
 * Uma falha de rede não vira aviso — é "não sei", e o que estava na tela fica.
 */
export function workerAliveRefresher(
  loadMe: () => Promise<{ worker?: { alive: boolean } }>,
  onAlive: (alive: boolean) => void,
  options: { everyMs?: number; now?: () => number } = {},
): () => Promise<void> {
  const everyMs = options.everyMs ?? WORKER_HEARTBEAT_MS;
  const now = options.now ?? (() => Date.now());
  let askedAt = Number.NEGATIVE_INFINITY;
  return async () => {
    if (now() - askedAt < everyMs) return;
    askedAt = now();
    const me = await loadMe().catch(() => null);
    if (!me) return;
    // Um servidor mais antigo não manda `worker`; um servidor antigo não é um worker morto.
    onAlive(me.worker?.alive ?? true);
  };
}
