import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./packages/testkit/src/verify-fast-env.ts"],
    include: [
      "packages/*/src/**/*.test.ts",
      "infra/sandboxes/supervisor/src/**/*.test.ts",
      "apps/desktop/src/**/*.test.ts",
      "apps/web/src/**/*.test.{ts,tsx}",
      "apps/www/src/**/*.test.ts",
      "apps/mobile/lib/**/*.test.ts",
      "apps/api/src/**/*.test.ts",
      "apps/worker/src/**/*.test.ts",
      "apps/cli/src/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // The suite is already deliberately file-serial because its PostgreSQL journeys share
    // durable state. Reusing one worker thread avoids hundreds of fork startups on developer
    // machines and constrained CI runners without reducing useful concurrency.
    pool: "threads",
    maxWorkers: 1,
    fileParallelism: false,
  },
});
