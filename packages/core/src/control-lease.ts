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
 * O prazo anda com o uso: cada tecla ou clique do dono empurra a janela, e o heartbeat da tela
 * só empurra com prova de gente na frente dela — senão uma aba esquecida aberta seguraria o
 * teclado para sempre e o bot em `waiting_takeover` nunca receberia o computador de volta.
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
  /**
   * Última tecla, clique ou colagem de verdade. É o que separa "a pessoa está usando" de
   * "a aba ficou aberta": sem isto, o heartbeat de 60 s de uma tela esquecida empurrava o
   * prazo para sempre e o bot parado em `waiting_takeover` nunca recuperava o computador.
   */
  controlLastInputAt?: Date | null;
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

/** Quando o prazo atual foi escrito: o começo da janela de 15 minutos que está valendo. */
export function controlLeaseGrantedAt(
  session: ControlLeaseSnapshot,
  leaseMs: number = CONTROL_LEASE_MS,
): Date | null {
  if (!session.controlLeaseExpiresAt) return null;
  return new Date(session.controlLeaseExpiresAt.getTime() - leaseMs);
}

/**
 * Houve uso de verdade desde que este prazo foi escrito? O heartbeat sozinho não é prova de
 * nada — o navegador segue batendo com a aba no fundo e o celular com a tela apagada. Só uma
 * tecla, um clique ou uma colagem depois da última renovação valem outra janela.
 */
export function controlLeaseHasFreshInput(
  session: ControlLeaseSnapshot,
  leaseMs: number = CONTROL_LEASE_MS,
): boolean {
  const grantedAt = controlLeaseGrantedAt(session, leaseMs);
  const lastInput = session.controlLastInputAt;
  if (!grantedAt || !lastInput) return false;
  return lastInput.getTime() > grantedAt.getTime();
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

/**
 * O prazo que `computer.input` / `computer.heartbeat` acabou de devolver, aplicado ao status
 * que a tela já tem. Sem isto o rótulo "controle até HH:mm" ficava congelado no horário do
 * takeover e sumia quando aquele minuto passava, mesmo com o lease renovado. Devolve o mesmo
 * objeto quando nada muda, para a tela não redesenhar à toa.
 */
export function withControlLease<
  T extends { controlHolder: string; controlLeaseExpiresAt?: string | null },
>(status: T | null, expiresAt: string | null | undefined): T | null {
  if (!status || !expiresAt) return status;
  if (status.controlHolder !== "user") return status;
  if (status.controlLeaseExpiresAt === expiresAt) return status;
  return { ...status, controlLeaseExpiresAt: expiresAt };
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
      // Lease novo, folha em branco: o uso do dono anterior não conta como prova aqui.
      controlLastInputAt: null,
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
  input: {
    botId: string;
    leaseId: string;
    userId: string;
    now?: Date;
    leaseMs?: number;
    /** Gravado junto quando quem renovou foi uma tecla ou um clique, não o heartbeat. */
    lastInputAt?: Date;
  },
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
    data: {
      controlLeaseExpiresAt: expiresAt,
      ...(input.lastInputAt ? { controlLastInputAt: input.lastInputAt } : {}),
    },
  });
  if (renewed.count !== 1) return null;
  return { expiresAt };
}

/**
 * Anota que a pessoa usou o computador, sem mexer no prazo. É o bilhete que o heartbeat lê
 * depois para saber se vale outra janela; escrito no máximo uma vez por janela, então o
 * trackpad continua sem escrever no banco a cada movimento.
 */
export async function markControlLeaseInput(
  db: ControlLeaseDb,
  input: { botId: string; leaseId: string; userId: string; now?: Date },
): Promise<boolean> {
  const marked = await db.desktopSession.updateMany({
    where: {
      botId: input.botId,
      controlHolder: "user",
      controlLeaseId: input.leaseId,
      controlLeaseUserId: input.userId,
    },
    data: { controlLastInputAt: input.now ?? new Date() },
  });
  return marked.count === 1;
}

/** De onde veio a batida: uma tecla/clique da pessoa, ou o heartbeat que a tela manda sozinha. */
export type ControlLeaseUse = "input" | "heartbeat";

/**
 * O que cada batida do dono faz com o lease.
 *
 * `input` é uso de verdade: anota a hora (uma vez por janela) e, passada a folga, empurra o
 * prazo e reagenda o `control.reap` para o prazo novo (mesmo `jobKey`, então o agendamento
 * antigo é substituído, não somado).
 *
 * `heartbeat` não é uso: uma aba deixada aberta bate a cada 60 s sem ninguém na frente, e
 * renovar por isso segurava o teclado para sempre — o bot parado em `waiting_takeover` nunca
 * voltava e o colega ouvia "outra pessoa está no controle" sem fim. Então o heartbeat só
 * renova com prova de gente: tecla ou clique **depois** da última renovação, ou o `atScreen`
 * do cliente. Sem prova ele apenas acorda o container e o prazo segue correndo até o reap.
 *
 * `atScreen` existe porque quem dirige a tela embutida (noVNC) não passa por
 * `computer.input`: as teclas vão direto pelo WebSocket do próprio noVNC, e o servidor não
 * as vê. Então o cliente afirma o que só ele sabe — a aba está à vista, a janela em foco e o
 * teclado dentro do quadro da tela (no celular: o app em primeiro plano nessa tela). Sem
 * isso, quem passasse 20 minutos preenchendo um formulário dentro do noVNC perderia o
 * controle no meio, que é o bug que o prazo por uso veio corrigir.
 *
 * Quem não é o dono não renova nada — o lease é de quem assumiu.
 */
export async function touchControlLease(
  deps: { db: ControlLeaseDb; wakeup?: WakeupDriver },
  session: ControlLeaseSnapshot,
  input: {
    botId: string;
    userId: string;
    now?: Date;
    leaseMs?: number;
    use?: ControlLeaseUse;
    /** O cliente afirma que a pessoa está na frente da tela do bot agora. */
    atScreen?: boolean;
  },
): Promise<{ expiresAt: Date } | null> {
  const now = input.now ?? new Date();
  const use = input.use ?? "input";
  const check = checkControlLease(session, { userId: input.userId }, now);
  if (!check.ok) return null;
  const leaseMs = input.leaseMs ?? CONTROL_LEASE_MS;
  const fresh = controlLeaseHasFreshInput(session, leaseMs);
  if (use === "heartbeat" && !fresh && !input.atScreen) return null;
  if (!controlLeaseWantsRenewal(session, now)) {
    // Ainda dentro da folga: guarda só o bilhete de uso, para o heartbeat de daqui a pouco
    // saber que havia alguém teclando. Uma escrita por janela, não uma por tecla.
    if (use === "input" && !fresh) {
      await markControlLeaseInput(deps.db, {
        botId: input.botId,
        leaseId: check.leaseId,
        userId: input.userId,
        now,
      });
    }
    return null;
  }
  const renewed = await renewControlLease(deps.db, {
    botId: input.botId,
    leaseId: check.leaseId,
    userId: input.userId,
    now,
    leaseMs: input.leaseMs,
    ...(use === "input" ? { lastInputAt: now } : {}),
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
      controlLastInputAt: null,
      waitingTakeover: false,
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
