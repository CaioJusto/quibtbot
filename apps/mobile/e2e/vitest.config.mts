import { defineConfig } from "vitest/config";

/**
 * Isolated from the root `vitest.config.ts` (which only includes `apps/mobile/lib/**`) so
 * that `pnpm --filter @quibt/mobile test` stays a fast unit suite and this system journey
 * runs only via `pnpm e2e:mobile` / `pnpm --filter @quibt/mobile e2e`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.e2e.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
