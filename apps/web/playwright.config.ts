import { defineConfig } from "@playwright/test"

// Dedicated ports so the e2e never clashes with a dev server on the usual ones.
// Overridable via env so parallel worktrees / agents don't reuse each other's
// server (each running agent should pick a distinct PW_WEB_PORT/PW_API_PORT).
const API_PORT = Number(process.env.PW_API_PORT ?? 8392)
const WEB_PORT = Number(process.env.PW_WEB_PORT ?? 3392)
const WEB = `http://localhost:${WEB_PORT}`

// Isolation model: every test signs up a fresh user, and the API runs with
// DOCK_MULTI_WORKSPACE=true so each of those users owns an isolated personal
// workspace. Workspace-scoped data (artifacts, members, settings, collections)
// never crosses between tests, so owner-dependent flows (share, settings) are
// deterministic instead of order-dependent — which lets us run fully in parallel.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  workers: process.env.CI ? 4 : 3,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: WEB,
    testIdAttribute: "data-testid",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command: `rm -rf apps/api/.e2e-data && PORT=${API_PORT} DATA_DIR=.e2e-data DOCK_MULTI_WORKSPACE=true DOCK_WEB_ORIGIN=${WEB} DOCK_RATE_LIMIT=false pnpm --filter @dock/api dev`,
      url: `http://localhost:${API_PORT}/healthz`,
      cwd: "../..",
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `DOCK_API=http://localhost:${API_PORT} pnpm --filter @dock/web dev --port ${WEB_PORT} --strictPort`,
      url: WEB,
      cwd: "../..",
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
})
