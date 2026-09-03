/**
 * Quibt Bot Cloud — shared types and quota/limit logic.
 *
 * REVIEW: the HTTP field names below are a **working hypothesis** for the
 * separate Cloud SaaS API (still being built). Keep parsers tolerant; do not
 * treat this as the final contract.
 */

export const QUIBT_CLOUD_KIND = "quibt-cloud" as const;

/**
 * Reserved `.invalid` host (RFC 2606). Not a real Cloud API — replace via
 * `QUIBT_CLOUD_API_URL` when the backend contract is confirmed.
 */
export const QUIBT_CLOUD_API_URL_PLACEHOLDER = "https://cloud.quibt.invalid";

export type QuibtCloudBoxStatus = "running" | "stopped";

export type QuibtCloudLimitKind = "hours" | "concurrent";

export interface QuibtCloudPlan {
  id: string;
  name: string;
}

export interface QuibtCloudMe {
  email?: string;
  plan: QuibtCloudPlan;
  /** Equivalent hours used in the current billing cycle. */
  hoursUsed: number;
  /** Plan hour cap for the cycle. */
  hoursQuota: number;
  /** Boxes currently running. */
  concurrentComputers: number;
  /** Max boxes that may run at once. */
  concurrentLimit: number;
}

export interface QuibtCloudBox {
  id: string;
  status: QuibtCloudBoxStatus;
}

export interface QuibtCloudConnection {
  host: string;
  port: number;
  /** REVIEW: protocol may be omitted; default is noVNC-style HTTP. */
  protocol?: "novnc" | "vnc" | "ssh";
  username?: string;
  /** Short-lived password or token for the screen / SSH. */
  credential?: string;
  /** Ready-made noVNC (or similar) URL, when the Cloud API already built one. */
  screenUrl?: string;
  path?: string;
}

export interface QuibtCloudLimit {
  kind: QuibtCloudLimitKind;
  message: string;
  upgradeMessage: string;
}

export interface QuibtCloudUsage {
  hoursUsed: number;
  hoursQuota: number;
  hoursRatio: number;
  hoursExhausted: boolean;
  concurrentComputers: number;
  concurrentLimit: number;
  concurrentAtLimit: boolean;
  blocked: boolean;
  limit: QuibtCloudLimit | null;
}

export function resolveQuibtCloudApiUrl(input: {
  override?: string | null;
  envUrl?: string | null;
} = {}): string {
  const override = input.override?.trim();
  if (override) return stripTrailingSlash(override);
  const envUrl = input.envUrl?.trim();
  if (envUrl) return stripTrailingSlash(envUrl);
  return QUIBT_CLOUD_API_URL_PLACEHOLDER;
}

export function isQuibtCloudPlaceholderUrl(url: string): boolean {
  return stripTrailingSlash(url) === QUIBT_CLOUD_API_URL_PLACEHOLDER;
}

export function quibtCloudUpgradeMessage(kind: QuibtCloudLimitKind): string {
  if (kind === "hours") {
    return "O plano Cloud esgotou as horas deste ciclo. Faça upgrade para continuar ligando o computador — o app segue funcionando.";
  }
  return "O plano Cloud já tem o máximo de computadores ligados. Faça upgrade ou desligue outro — o app segue funcionando.";
}

export function quibtCloudLimitFromKind(kind: QuibtCloudLimitKind): QuibtCloudLimit {
  const upgradeMessage = quibtCloudUpgradeMessage(kind);
  return {
    kind,
    message:
      kind === "hours"
        ? "As horas-equivalentes do plano Cloud deste ciclo acabaram."
        : "O limite de computadores simultâneos do plano Cloud foi atingido.",
    upgradeMessage,
  };
}

export function quibtCloudUsage(me: QuibtCloudMe): QuibtCloudUsage {
  const hoursQuota = finiteNumber(me.hoursQuota);
  const hoursUsed = Math.max(0, finiteNumber(me.hoursUsed));
  const concurrentLimit = Math.max(0, finiteNumber(me.concurrentLimit));
  const concurrentComputers = Math.max(0, finiteNumber(me.concurrentComputers));
  const hoursExhausted = hoursQuota > 0 ? hoursUsed >= hoursQuota : hoursUsed > 0 && hoursQuota === 0;
  const concurrentAtLimit = concurrentLimit > 0 && concurrentComputers >= concurrentLimit;
  const kind: QuibtCloudLimitKind | null = hoursExhausted
    ? "hours"
    : concurrentAtLimit
      ? "concurrent"
      : null;
  return {
    hoursUsed,
    hoursQuota,
    hoursRatio: hoursQuota > 0 ? Math.min(1, hoursUsed / hoursQuota) : hoursExhausted ? 1 : 0,
    hoursExhausted,
    concurrentComputers,
    concurrentLimit,
    concurrentAtLimit,
    blocked: Boolean(kind),
    limit: kind ? quibtCloudLimitFromKind(kind) : null,
  };
}

/**
 * Starting a stopped box consumes one concurrent slot and more hours.
 * A box that is already running may stay up (refresh / reconnect).
 */
export function quibtCloudCanResume(
  me: QuibtCloudMe,
  box?: Pick<QuibtCloudBox, "status"> | null,
): { ok: true } | { ok: false; limit: QuibtCloudLimit } {
  const usage = quibtCloudUsage(me);
  if (usage.hoursExhausted) return { ok: false, limit: quibtCloudLimitFromKind("hours") };
  if (box?.status === "running") return { ok: true };
  if (usage.concurrentAtLimit) return { ok: false, limit: quibtCloudLimitFromKind("concurrent") };
  return { ok: true };
}

export function formatQuibtCloudHours(me: QuibtCloudMe): string {
  const used = formatHours(me.hoursUsed);
  const quota = formatHours(me.hoursQuota);
  return `${used} / ${quota} h neste ciclo`;
}

export function screenUrlFromQuibtCloudConnection(
  connection: QuibtCloudConnection,
): string | null {
  const ready = connection.screenUrl?.trim();
  if (ready) return ready;
  if (connection.protocol === "ssh") return null;
  const host = connection.host?.trim();
  const port = Number(connection.port);
  if (!host || !Number.isFinite(port) || port <= 0) return null;
  const path = connection.path?.trim() || "/vnc.html";
  const base = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`http://${host}:${port}${base}`);
  if (!url.searchParams.has("autoconnect")) url.searchParams.set("autoconnect", "1");
  if (connection.credential && !url.searchParams.has("password")) {
    url.searchParams.set("password", connection.credential);
  }
  return url.toString();
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function finiteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function formatHours(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
