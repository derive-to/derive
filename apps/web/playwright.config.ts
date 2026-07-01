import { createHash } from "node:crypto"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "@playwright/test"

// Per-worktree ports, derived from this checkout's path. Each worktree (and each
// agent) automatically gets its own e2e server ports, so a run never attaches to
// a different worktree's server (the one cross-checkout flake we saw locally).
// The slot is stable per checkout, so repeated runs here reuse the warm server
// (both servers watch/HMR, so reuse never serves stale code). PW_*_PORT overrides
// for the rare same-slot collision. Ports land clear of the usual dev servers.
const worktreeDir = dirname(fileURLToPath(import.meta.url))
const portSlot =
  parseInt(createHash("sha1").update(worktreeDir).digest("hex").slice(0, 4), 16) % 600
const API_PORT = Number(process.env.PW_API_PORT ?? 8300 + portSlot)
const WEB_PORT = Number(process.env.PW_WEB_PORT ?? 3300 + portSlot)
const WEB = `http://localhost:${WEB_PORT}`

// Isolation model: every test signs up a fresh user, and the API runs with
// DERIVE_MULTI_WORKSPACE=true so each of those users owns an isolated personal
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
  // Two suites, one shared server (multi-workspace isolation makes that safe):
  //  • smoke — one fast critical path per surface; the post-merge gate.
  //  • deep  — comprehensive per-surface + responsive; the nightly/regression run.
  // `--project=smoke` / `--project=deep` selects one; no flag runs both.
  projects: [
    { name: "smoke", testMatch: /smoke\/.*\.spec\.ts$/ },
    { name: "deep", testMatch: /deep\/.*\.spec\.ts$/ },
  ],
  webServer: [
    {
      command: `rm -rf apps/api/.e2e-data && PORT=${API_PORT} DATA_DIR=.e2e-data DERIVE_MULTI_WORKSPACE=true DERIVE_WEB_ORIGIN=${WEB} DERIVE_RATE_LIMIT=false pnpm --filter @derive/api dev`,
      url: `http://localhost:${API_PORT}/healthz`,
      cwd: "../..",
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `DERIVE_API=http://localhost:${API_PORT} pnpm --filter @derive/web dev --port ${WEB_PORT} --strictPort`,
      url: WEB,
      cwd: "../..",
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
})
