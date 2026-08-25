import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALL_RELEASE } from "./compose.js";
import { CONTAINER_MIGRATE_ARGS, migrateInvocation, migrationFailureMessage } from "./migrate.js";

const composeRoot = path.resolve("infra/compose");

describe("quibt-migrate stack image entrypoint", () => {
  it("installs quibt-migrate in the Dockerfile with executable permissions", () => {
    const dockerfile = readFileSync(path.join(composeRoot, "Dockerfile"), "utf8");
    const script = readFileSync(path.join(composeRoot, "quibt-migrate"), "utf8");
    expect(dockerfile).toContain("COPY infra/compose/quibt-migrate /usr/local/bin/quibt-migrate");
    expect(dockerfile).toMatch(/chmod.*quibt-migrate/);
    expect(script).toContain("prisma migrate deploy");
  });

  it("generates the Prisma client in the reusable stack image", () => {
    const dockerfile = readFileSync(path.join(composeRoot, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("pnpm --filter @quibt/db generate");
  });

  it("invokes quibt-migrate without embedding pnpm in the compose command", () => {
    const base = ["compose", "-f", "/tmp/compose.yml", "--env-file", "/tmp/quibt.env"];
    const migrate = migrateInvocation(base);
    expect(migrate).toEqual([...base, ...CONTAINER_MIGRATE_ARGS]);
    expect(migrate.join(" ")).toContain("quibt-migrate");
    expect(migrate.join(" ")).not.toContain("pnpm --filter");
  });

  it("cites the actionable image tag when the entrypoint is missing", () => {
    const message = migrationFailureMessage("quibt-migrate: not found", INSTALL_RELEASE);
    expect(message).toContain(`ghcr.io/quibt/quibt-stack:${INSTALL_RELEASE}`);
    expect(message).toContain("quibt-migrate");
  });
});
