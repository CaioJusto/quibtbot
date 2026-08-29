import { describe, expect, it } from "vitest";
import { appServicesUpInvocation, composeInvocation, postgresUpInvocation } from "./compose.js";
import { CONTAINER_MIGRATE_ARGS, migrateInvocation } from "./migrate.js";

const composeFile = "/tmp/compose.yml";
const envFile = "/tmp/quibt.env";
const base = ["compose", "-f", composeFile, "--env-file", envFile];

describe("packaged install compose order", () => {
  it("starts postgres before one-shot migration and app services", () => {
    const postgresUp = postgresUpInvocation("packaged", composeFile, envFile);
    const migrate = migrateInvocation(base);
    const appsUp = appServicesUpInvocation("packaged", composeFile, envFile);

    expect(postgresUp).toEqual([...base, "up", "-d", "--wait", "postgres"]);
    expect(migrate).toEqual([...base, ...CONTAINER_MIGRATE_ARGS]);
    expect(migrate.join(" ")).toContain("run --rm");
    expect(migrate.join(" ")).not.toContain("exec -T");
    expect(appsUp).toEqual([...base, "up", "-d", "supervisor", "api", "worker", "web", "computer"]);

    expect(postgresUp).not.toContain("--build");
    expect(appsUp).not.toContain("--build");
    expect(appsUp).not.toContain("--wait");
    expect(composeInvocation("packaged", composeFile, envFile, "up")).not.toContain("--build");
  });

  it("surfaces actionable migration failure when entrypoint is missing", () => {
    const migrate = migrateInvocation(base).join(" ");
    expect(migrate).toContain("quibt-migrate");
    expect(migrate).not.toContain("pnpm --filter");
  });
});
