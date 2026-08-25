/**
 * Takeover control leases.
 *
 * One computer, one keyboard: control belongs to a single workspace member at a time. Taking over
 * writes an unguessable lease id, the member who owns it, a deadline, and a fence that moves on
 * every takeover. While that lease is live another member is refused (they are told who has it);
 * the holder may keep taking over, which renews the deadline. Once the deadline passes the lease
 * is dead for everyone: the bot gets its computer back, any run parked in `waiting_takeover` is
 * woken, and the next member to ask gets control.
 *
 * The fence is what the sandbox sees, so input from a lease that was superseded mid-flight is
 * recognisable as stale rather than replayed as if it were current.
 */
import type { WakeupDriver } from "@quibt/adapter-kit";

/** How long one takeover holds the keyboard before the bot may have its computer back. */
export const CONTROL_LEASE_MS = 15 * 60_000;

/**
 * Usar o teclado renova o prazo, mas não a cada tecla: o modo trackpad manda dezenas de
 * movimentos por segundo, e cada renovação é uma escrita no banco mais um reagendamento do
 * `control.reap`. Só vale renovar depois que este tanto do prazo já foi consumido.
 */
export const CONTROL_LEASE_RENEW_GAP_MS = 60_000;

/**
 * An unguessable lease id. `lease-<botId>` was guessable by anyone who could see a bot id, and
 * nothing checked it anyway.
 */
export function newControlLeaseId(): string {
  // The global Web Crypto API: @quibt/core is bundled by Vite (web) and Metro (mobile), and
  // neither resolves `node:crypto`. Importing it here whitescreens the web app at boot.
  return `ctl_${globalThis.crypto.randomUUID()}`;
}

export interface ControlLeaseSnapshot {
  controlHolder: string;
  controlLeaseId: string | null;
  controlLeaseUserId: string | null;
  controlLeaseExpiresAt: Date | null;
  controlFence: number;
}

/** Live means: a user holds it, and the recorded expiry has not passed. */
export function controlLeaseLive(session: ControlLeaseSnapshot, now: Date): boolean {
  if (session.controlHolder !== "user") return false;
  // Leases written before expiry was persisted have no deadline; treat them as dead so a bot
  // stranded by the old code recovers instead of waiting forever.
  if (!session.controlLeaseExpiresAt) return false;
  return session.controlLeaseExpiresAt.getTime() > now.getTime();
}

export type ControlDenial = "bot_in_control" | "expired" | "other_holder" | "wrong_lease";

export type ControlCheck =
  | { ok: true; fence: number; leaseId: string }
  | { ok: false; reason: ControlDenial };

/**
 * The server-side half of a takeover. `computer.input` used to accept anything as long as the
 * column said "user": no lease id, no expiry, and a hardcoded fence of 0.
 */
export function checkControlLease(
  session: ControlLeaseSnapshot,
  request: { userId: string; leaseId?: string | undefined },
  now: Date,
): ControlCheck {
  if (session.controlHolder !== "user" || !session.controlLeaseId) {
    return { ok: false, reason: "bot_in_control" };
  }
  if (!controlLeaseLive(session, now)) return { ok: false, reason: "expired" };
  if (session.controlLeaseUserId && session.controlLeaseUserId !== request.userId) {
    return { ok: false, reason: "other_holder" };
  }
  if (request.leaseId && request.leaseId !== session.controlLeaseId) {
    return { ok: false, reason: "wrong_lease" };
  }
  return { ok: true, fence: session.controlFence, leaseId: session.controlLeaseId };
}

/** Whether `userId` may take the keyboard now, and from whom. */
export function canTakeControl(
  session: ControlLeaseSnapshot,
  userId: string,
  now: Date,
): { ok: true; renew: boolean } | { ok: false; holderUserId: string | null } {
  if (!controlLeaseLive(session, now)) return { ok: true, renew: false };
  if (session.controlLeaseUserId && session.controlLeaseUserId !== userId) {
    return { ok: false, holderUserId: session.controlLeaseUserId };
  }
  return { ok: true, renew: true };
}

/**
 * Se vale renovar o prazo agora. Quem está preenchendo um formulário há 15 minutos via a
 * tela virar "Assuma o controle para ver a tela" e as teclas seguintes falharem em silêncio:
 * o prazo era fixo desde o takeover, e o heartbeat só acordava o container. Cada uso
 * (heartbeat, tecla, mouse) do próprio dono empurra o prazo — mas só depois de consumido
 * `gapMs`, para não escrever no banco a cada movimento do trackpad.
 */
export function controlLeaseWantsRenewal(
  session: ControlLeaseSnapshot,
  now: Date,
  gapMs: number = CONTROL_LEASE_RENEW_GAP_MS,
): boolean {
  if (!controlLeaseLive(session, now)) return false;
  const remaining = (session.controlLeaseExpiresAt as Date).getTime() - now.getTime();
  return remaining <= CONTROL_LEASE_MS - gapMs;
}

/**
 * "controle até 14:35", no fuso do aparelho. `null` quando não há prazo ou ele já passou —
 * a tela mostra então só "Você tem o controle", como antes.
 */
export function controlUntilLabel(
  expiresAt: string | Date | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!expiresAt) return null;
  const deadline = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= now.getTime()) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `até ${pad(deadline.getHours())}:${pad(deadline.getMinutes())}`;
}

/** Prisma shape this module needs, so @quibt/core stays free of a database dependency. */
export interface ControlLeaseDb {
  desktopSession: {
    findMany(args: unknown): Promise<Array<{ botId: string; controlFence: number }>>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
}

export interface ControlReapDb extends ControlLeaseDb {
  run: { findFirst(args: unknown): Promise<{ id: string } | null> };
}

/** The job that ends one bot's lease, scheduled for the exact moment the lease runs out. */
export function scheduleControlReap(
  wakeup: WakeupDriver | undefined,
  botId: string,
  runAt: Date,
): void {
  if (!wakeup || !botId) return;
  void wakeup
    .enqueue({
      name: "control.reap",
      payload: { botId },
      runAt,
      jobKey: `control.reap:${botId}`,
    })
    .catch((error) => console.error("control.reap", error));
}

/**
 * Ends expired control and wakes the run that was parked waiting for a human. Without this a
 * bot whose user walked away stays in `waiting_takeover` until someone notices.
 */
export async function reapControl(
  deps: { db: ControlReapDb; wakeup?: WakeupDriver },
  options?: { botId?: string; now?: Date },
): Promise<string[]> {
  const released = await reapExpiredControlLeases(deps.db, options);
  for (const botId of released) {
    const waiting = await deps.db.run
      .findFirst({
        where: { botId, status: "waiting_takeover" },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      })
      .catch(() => null);
    if (!waiting) continue;
    await deps.wakeup
      ?.enqueue({ name: "run.continue", payload: { runId: waiting.id } })
      .catch((error) => console.error("run.continue", error));
  }
  return released;
}

export interface GrantedControl {
  leaseId: string;
  expiresAt: Date;
  fence: number;
}

/**
 * Takes control with a compare-and-set on the fence, so two people pressing the button at the
 * same moment cannot both believe they hold the keyboard.
 */
export async function grantControlLease(
  db: ControlLeaseDb,
  input: {
    botId: string;
    userId: string;
    fence: number;
    now?: Date;
    leaseMs?: number;
    leaseId?: string;
  },
): Promise<GrantedControl | null> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.leaseMs ?? CONTROL_LEASE_MS));
  const leaseId = input.leaseId ?? newControlLeaseId();
  const fence = input.fence + 1;
  const claimed = await db.desktopSession.updateMany({
    where: { botId: input.botId, controlFence: input.fence, state: { not: "deleting" } },
    data: {
      controlHolder: "user",
      controlLeaseId: leaseId,
      controlLeaseUserId: input.userId,
      controlLeaseExpiresAt: expiresAt,
      controlFence: fence,
      state: "running",
      bootClaimToken: null,
      bootClaimedAt: null,
    },
  });
  if (claimed.count !== 1) return null;
  return { leaseId, expiresAt, fence };
}

/**
 * Empurra o prazo do lease que o dono já tem, sem mexer no fence nem no id: o app guarda o
 * `leaseId` e o sandbox confere o fence, então trocar qualquer um dos dois no meio do uso
 * derrubaria a pessoa. Guardado pelo id e pelo dono: um lease que outra pessoa acabou de
 * tomar (id novo) não é renovado por engano.
 */
export async function renewControlLease(
  db: ControlLeaseDb,
  input: { botId: string; leaseId: string; userId: string; now?: Date; leaseMs?: number },
): Promise<{ expiresAt: Date } | null> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.leaseMs ?? CONTROL_LEASE_MS));
  const renewed = await db.desktopSession.updateMany({
    where: {
      botId: input.botId,
      controlHolder: "user",
      controlLeaseId: input.leaseId,
      controlLeaseUserId: input.userId,
    },
    data: { controlLeaseExpiresAt: expiresAt },
  });
  if (renewed.count !== 1) return null;
  return { expiresAt };
}

/**
 * O que cada uso do dono (heartbeat, tecla, mouse) faz com o lease: nada enquanto a folga não
 * foi consumida; depois dela, empurra o prazo e reagenda o `control.reap` para o prazo novo
 * (mesmo `jobKey`, então o agendamento antigo é substituído, não somado). Quem não é o dono
 * não renova nada — o lease é de quem assumiu.
 */
export async function touchControlLease(
  deps: { db: ControlLeaseDb; wakeup?: WakeupDriver },
  session: ControlLeaseSnapshot,
  input: { botId: string; userId: string; now?: Date; leaseMs?: number },
): Promise<{ expiresAt: Date } | null> {
  const now = input.now ?? new Date();
  const check = checkControlLease(session, { userId: input.userId }, now);
  if (!check.ok) return null;
  if (!controlLeaseWantsRenewal(session, now)) return null;
  const renewed = await renewControlLease(deps.db, {
    botId: input.botId,
    leaseId: check.leaseId,
    userId: input.userId,
    now,
    leaseMs: input.leaseMs,
  });
  if (!renewed) return null;
  scheduleControlReap(deps.wakeup, input.botId, renewed.expiresAt);
  return renewed;
}

/** Hands the keyboard back to the bot. Guarded by the fence so it cannot cancel a newer lease. */
export async function releaseControlLease(
  db: ControlLeaseDb,
  input: { botId: string; fence: number },
): Promise<boolean> {
  const released = await db.desktopSession.updateMany({
    where: { botId: input.botId, controlFence: input.fence, controlHolder: "user" },
    data: {
      controlHolder: "bot",
      controlLeaseId: null,
      controlLeaseUserId: null,
      controlLeaseExpiresAt: null,
    },
  });
  return released.count === 1;
}

/**
 * Whoever takes control and walks away used to keep it forever, leaving the bot parked in
 * `waiting_takeover`. This gives the computer back once the lease deadline passes.
 */
export async function reapExpiredControlLeases(
  db: ControlLeaseDb,
  options?: { now?: Date; botId?: string; limit?: number },
): Promise<string[]> {
  const now = options?.now ?? new Date();
  const expired = await db.desktopSession.findMany({
    where: {
      controlHolder: "user",
      ...(options?.botId ? { botId: options.botId } : {}),
      OR: [{ controlLeaseExpiresAt: { lt: now } }, { controlLeaseExpiresAt: null }],
    },
    select: { botId: true, controlFence: true },
    take: options?.limit ?? 50,
  });
  const released: string[] = [];
  for (const session of expired) {
    if (await releaseControlLease(db, { botId: session.botId, fence: session.controlFence })) {
      released.push(session.botId);
    }
  }
  return released;
}
