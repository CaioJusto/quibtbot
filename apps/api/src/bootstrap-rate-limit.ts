import { hmacSha256Hex } from "@quibt/core/secrets-guard";
import type { PrismaClient } from "@quibt/db";

const RATE_LIMIT_LABEL = "quibt-bot/bootstrap-rate-limit/v1";
const DEPLOYMENT_ID = "default";

export function hashBootstrapClientIp(ip: string, encryptionKey: string): string {
  const bounded = ip.trim().slice(0, 128) || "unknown";
  return hmacSha256Hex(encryptionKey, `${RATE_LIMIT_LABEL}:ip:${bounded}`);
}

export function bootstrapRateLimitBucketKey(
  scope: "mint" | "claim" | "pairing",
  ip: string,
  encryptionKey: string,
): string {
  const ipHash = hashBootstrapClientIp(ip, encryptionKey);
  return hmacSha256Hex(encryptionKey, `${RATE_LIMIT_LABEL}:${DEPLOYMENT_ID}:${scope}:${ipHash}`);
}

export async function checkPersistentBootstrapRateLimit(
  prisma: PrismaClient,
  scope: "mint" | "claim" | "pairing",
  ip: string,
  encryptionKey: string,
  limit = 10,
  windowSeconds = 60,
): Promise<boolean> {
  const bucketKey = bootstrapRateLimitBucketKey(scope, ip, encryptionKey);
  const rows = await prisma.$queryRaw<Array<{ hit_count: number }>>`
    INSERT INTO "bootstrap_rate_limits" (
      "bucketKey", "hitCount", "windowStartedAt", "expiresAt"
    )
    VALUES (
      ${bucketKey},
      1,
      NOW(),
      NOW() + make_interval(secs => ${windowSeconds})
    )
    ON CONFLICT ("bucketKey") DO UPDATE SET
      "hitCount" = CASE
        WHEN "bootstrap_rate_limits"."expiresAt" <= NOW() THEN 1
        ELSE "bootstrap_rate_limits"."hitCount" + 1
      END,
      "windowStartedAt" = CASE
        WHEN "bootstrap_rate_limits"."expiresAt" <= NOW() THEN NOW()
        ELSE "bootstrap_rate_limits"."windowStartedAt"
      END,
      "expiresAt" = CASE
        WHEN "bootstrap_rate_limits"."expiresAt" <= NOW()
          THEN NOW() + make_interval(secs => ${windowSeconds})
        ELSE "bootstrap_rate_limits"."expiresAt"
      END
    RETURNING "hitCount" AS hit_count
  `;
  const hitCount = Number(rows[0]?.hit_count ?? limit + 1);
  return hitCount <= limit;
}
