import { INSTALL_RELEASE } from "./compose.js";

/** One-shot container migration before app services start (no running api container required). */
export const CONTAINER_MIGRATE_ARGS = ["run", "--rm", "--no-deps", "api", "quibt-migrate"] as const;

export const MIGRATION_ENTRYPOINT_MISSING_MESSAGE =
  "Migration failed: quibt-migrate is missing in the quibt-stack image. Rebuild and publish ghcr.io/quibt/quibt-stack:";

export function migrateInvocation(composeBaseArgs: string[]): string[] {
  return [...composeBaseArgs, ...CONTAINER_MIGRATE_ARGS];
}

export function migrationFailureMessage(stderr: string, release = INSTALL_RELEASE): string {
  if (
    /quibt-migrate.*not found|executable file not found.*quibt-migrate|ENOENT.*quibt-migrate/i.test(
      stderr,
    )
  ) {
    return `${MIGRATION_ENTRYPOINT_MISSING_MESSAGE}${release} with the quibt-migrate entrypoint.`;
  }
  if (/pnpm.*not found|command not found.*pnpm|ENOENT.*pnpm/i.test(stderr)) {
    return `${MIGRATION_ENTRYPOINT_MISSING_MESSAGE}${release} with the quibt-migrate entrypoint (image build is incomplete).`;
  }
  return stderr.trim() || "migration failed";
}
