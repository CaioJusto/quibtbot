-- Repair historical duplicate defaults before enforcing the tenant invariant.
WITH ranked_defaults AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "userId", "workspaceId"
      ORDER BY "updatedAt" DESC, "id" DESC
    ) AS default_rank
  FROM "user_model_credentials"
  WHERE "isDefault" = true
)
UPDATE "user_model_credentials" AS credential
SET "isDefault" = false
FROM ranked_defaults
WHERE credential."id" = ranked_defaults."id"
  AND ranked_defaults.default_rank > 1;

CREATE UNIQUE INDEX "user_model_credentials_one_default_per_workspace"
ON "user_model_credentials"("userId", "workspaceId")
WHERE "isDefault" = true;
