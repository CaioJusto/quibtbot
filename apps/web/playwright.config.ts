import { defineConfig, devices } from "@playwright/test";

const webPort = Number(process.env.WEB_PORT ?? 5173);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${webPort}`;

if (!process.env.CI && process.env.QUIBT_E2E_ISOLATED !== "1") {
  throw new Error(
    "Playwright requires an isolated Quibt test environment. Run `pnpm e2e` from the repository root.",
  );
}

export default defineConfig({
  testDir: "./e2e",
  // These journeys intentionally share one fresh, single-owner deployment. Parallel
  // spec files would race first-owner creation and turn a valid 409 into a stuck
  // device-code screen, which tests scheduler timing instead of product behavior.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "../../playwright-report" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    url: baseURL,
    // Never attach the destructive E2E journey to a person's already running Quibt.
    // `pnpm verify` supplies an isolated database/API and a dedicated port (5180).
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
