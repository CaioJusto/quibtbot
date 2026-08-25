-- Move legacy per-workspace Box/E2B provider refs onto desktop sessions missing a ref.
UPDATE "desktop_sessions" AS ds
SET "providerRef" = c."providerRef"
FROM "computers" AS c
WHERE ds."computerId" = c.id
  AND c."kind" IN ('box', 'e2b')
  AND c."providerRef" IS NOT NULL
  AND ds."providerRef" IS NULL;

-- Per-bot providers keep refs on sessions only; clear stale computer-level refs.
UPDATE "computers"
SET "providerRef" = NULL
WHERE "kind" IN ('box', 'e2b')
  AND "providerRef" IS NOT NULL;
