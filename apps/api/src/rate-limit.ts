type Bucket = { count: number; resetAt: number };

/**
 * The general-purpose store, for identities the request itself doesn't fully control
 * (an authenticated session's IP, an RPC mutation's IP): `/api/auth/*` and rate-limited
 * `/rpc/*` mutations live here.
 */
const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 2_000;

/**
 * A separate store for `/hooks/*`, whose `endpointId` is fully attacker-controlled and
 * needs no authentication to try: an attacker who could put webhook keys in the same
 * Map as `buckets` could invent enough distinct endpoint ids to push `buckets` past
 * `MAX_BUCKETS`, evicting — and thereby silently resetting — an unrelated auth/rpc
 * bucket for the same IP. Kept fully separate so no volume of invented endpoint ids can
 * ever touch `buckets`. See `allowWebhookRequest`.
 */
const webhookBuckets = new Map<string, Bucket>();
const WEBHOOK_MAX_BUCKETS = 2_000;

function pruneBuckets(store: Map<string, Bucket>, now: number) {
  for (const [key, bucket] of store) {
    if (bucket.resetAt <= now) store.delete(key);
  }
}

function checkRate(
  store: Map<string, Bucket>,
  maxBuckets: number,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): boolean {
  const boundedKey = key.trim().slice(0, 256) || "unknown";
  pruneBuckets(store, now);
  const current = store.get(boundedKey);
  if (!current || current.resetAt <= now) {
    if (!current && store.size >= maxBuckets) {
      const oldest = store.keys().next().value;
      if (oldest) store.delete(oldest);
    }
    store.set(boundedKey, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

export function allowRequest(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): boolean {
  return checkRate(buckets, MAX_BUCKETS, key, limit, windowMs, now);
}

export function resetRateLimits() {
  buckets.clear();
  webhookBuckets.clear();
}

export function clientKey(ip: string | undefined, path: string) {
  return `${ip || "unknown"}:${path}`;
}

/**
 * O balde de cada caminho de autenticação. Trocar o código do QR por uma sessão é o
 * único endpoint que transforma uma string em login, então ele anda no balde mais
 * apertado — mesmo com um código de 32 caracteres, não há motivo para permitir rajadas.
 */
export function authRateLimit(path: string): { key: string; limit: number } {
  if (path.startsWith("/one-time-token")) return { key: "auth-pair", limit: 10 };
  if (path.startsWith("/sign")) return { key: "auth-sign", limit: 40 };
  return { key: "auth", limit: 40 };
}

/**
 * Mutations that cost money or wake bots. In-memory only: a second process has
 * its own buckets, so this is abuse friction, not a quota.
 */
const RATE_LIMITED_RPC_MUTATIONS = new Map([
  ["bots/create", 20],
  ["billing/checkout", 20],
  ["capabilities/install", 20],
  ["threads/send", 60],
  ["peers/send", 60],
  ["botGroups/send", 60],
]);

export function rpcMutationRateLimit(pathname: string): number | null {
  const procedure = pathname.replace(/^\/rpc\/?/, "").replace(/^\/+|\/+$/g, "");
  return RATE_LIMITED_RPC_MUTATIONS.get(procedure) ?? null;
}

/** Prefer the proxy-set client IP. Leftmost X-Forwarded-For is attacker-controlled. */
export function clientIp(
  headers: { get(name: string): string | undefined | null },
  peerIp = "local",
  trustedProxyIps: readonly string[] = [],
): string {
  const boundedPeer = peerIp.trim().slice(0, 128) || "local";
  if (trustedProxyIps.includes(boundedPeer)) {
    const real = headers.get("x-real-ip")?.trim().slice(0, 128);
    if (real) return real;
    const forwarded = headers.get("x-forwarded-for");
    if (forwarded) {
      const hops = forwarded
        .split(",")
        .map((hop) => hop.trim().slice(0, 128))
        .filter(Boolean);
      if (hops.length) return hops[hops.length - 1]!;
    }
  }
  return boundedPeer;
}

/** Every `/hooks/*` (IP, endpoint) pair is folded into one of this many buckets, so an
 * enumerated/invented `endpointId` can never grow `webhookBuckets` past a bounded number
 * of keys per IP — at most one global key plus `WEBHOOK_ENDPOINT_BUCKETS` bucket keys,
 * regardless of how many distinct endpoint ids were tried. */
export const WEBHOOK_ENDPOINT_BUCKETS = 64;

const WEBHOOK_GLOBAL_LIMIT_PER_MINUTE = 60;
const WEBHOOK_ENDPOINT_BUCKET_LIMIT_PER_MINUTE = 30;
const WEBHOOK_WINDOW_MS = 60_000;

/**
 * A simple, stable (non-cryptographic — no new dependency) string hash, folded into a
 * fixed, small bucket count. Deterministic: the same `endpointId` always lands in the
 * same bucket, which is what lets `allowWebhookRequest` enforce a focused per-endpoint
 * ceiling without ever storing a key per distinct `endpointId`.
 */
export function webhookEndpointBucket(endpointId: string): number {
  let hash = 0;
  for (let i = 0; i < endpointId.length; i += 1) {
    hash = (hash * 31 + endpointId.charCodeAt(i)) >>> 0;
  }
  return hash % WEBHOOK_ENDPOINT_BUCKETS;
}

/**
 * Two independent windows, both in `webhookBuckets` (never `buckets`, so no volume of
 * invented `endpointId`s can evict — and thereby silently reset — an auth/rpc bucket):
 *
 * - A per-IP global ceiling (60/min): closes distributed enumeration across many
 *   different endpoint ids, which a purely per-endpoint limit could never see coming
 *   since every new invented id starts its own fresh count.
 * - A per-(IP, endpoint bucket) ceiling (30/min, `webhookEndpointBucket` above): still
 *   locks out a focused flood against one real endpoint, tighter than the global one.
 *
 * Checked in that order: the global ceiling is the cheaper, coarser gate, and a request
 * blocked by it never needs the bucket check at all.
 */
export function allowWebhookRequest(ip: string, endpointId: string, now = Date.now()): boolean {
  const boundedIp = ip.trim().slice(0, 128) || "unknown";
  if (
    !checkRate(
      webhookBuckets,
      WEBHOOK_MAX_BUCKETS,
      `webhook-global:${boundedIp}`,
      WEBHOOK_GLOBAL_LIMIT_PER_MINUTE,
      WEBHOOK_WINDOW_MS,
      now,
    )
  ) {
    return false;
  }
  const bucket = webhookEndpointBucket(endpointId);
  return checkRate(
    webhookBuckets,
    WEBHOOK_MAX_BUCKETS,
    `webhook-bucket:${boundedIp}:${bucket}`,
    WEBHOOK_ENDPOINT_BUCKET_LIMIT_PER_MINUTE,
    WEBHOOK_WINDOW_MS,
    now,
  );
}
