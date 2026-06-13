import { defineConfig } from "@playwright/test"

// Dedicated ports so the e2e never clashes with a dev server on the usual ones.
// Overridable via env so parallel worktrees / agents don't reuse each other's
// server (each running agent should pick a distinct PW_WEB_PORT/PW_API_PORT).
const API_PORT = Number(process.env.PW_API_PORT ?? 8392)
const WEB_PORT = Number(process.env.PW_WEB_PORT ?? 3392)
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
      // The rm runs from cwd (repo root, below) but `pnpm --filter @dock/api dev`
      // runs in apps/api/, so DATA_DIR=.e2e-data lands at apps/api/.e2e-data —
      // clear THAT path, or the throwaway DB accumulates across runs and the
      // "first signup = workspace owner" assumption silently breaks.
      command: `rm -rf apps/api/.e2e-data && PORT=${API_PORT} DATA_DIR=.e2e-data DOCK_WEB_ORIGIN=${WEB} DOCK_RATE_LIMIT=false pnpm --filter @dock/api dev`,
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
