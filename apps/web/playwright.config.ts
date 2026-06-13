import { defineConfig } from "@playwright/test"

// Dedicated ports so the e2e never clashes with a dev server on the usual ones.
const API_PORT = 8392
const WEB_PORT = 3392
const WEB = `http://localhost:${WEB_PORT}`

// Boots a throwaway API (fresh SQLite each run) + the web app, then drives the
// real browser through the publish -> comment -> resolve loop.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: WEB, trace: "retain-on-failure" },
  webServer: [
    {
      command: `rm -rf .e2e-data && PORT=${API_PORT} DATA_DIR=.e2e-data DOCK_WEB_ORIGIN=${WEB} DOCK_RATE_LIMIT=false pnpm --filter @dock/api dev`,
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
