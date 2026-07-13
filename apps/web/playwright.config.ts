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
const ORIGIN = `http://localhost:${API_PORT}`
const isCI = !!process.env.CI

// Isolation model: every test signs up a fresh user, and the API runs with
// DERIVE_MULTI_WORKSPACE=true so each of those users owns an isolated personal
// workspace. Workspace-scoped data (artifacts, members, settings, collections)
// never crosses between tests, so owner-dependent flows (share, settings) are
// deterministic instead of order-dependent — which lets us run fully in parallel.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // 1 worker on CI. Each multi-context spec (owner + secondUser) already spawns two
  // browser contexts, so even 2 workers put 4 renderers on a 2-vCPU CI box — the
  // oversubscription that starved the UI and flaked toBeVisible. 1 is the safe floor;
  // deep-suite wall-clock is recovered by sharding, not more workers. Local keeps 3.
  workers: process.env.CI ? 1 : 3,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    // CI serves the built SPA from the API origin (single origin); local keeps the
    // two dev servers, so the web app is at WEB.
    baseURL: isCI ? ORIGIN : WEB,
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
    // Visual-QA capture harness (not a test gate): seeds a realistic workspace and
    // screenshots the real, auth-walled dashboard across themes + viewports. Its
    // specs self-skip unless SHOTS=1, so a bare `playwright test` never runs them.
    // Use: `SHOTS=1 npx playwright test --project=screens` (see e2e/screens/).
    { name: "screens", testMatch: /screens\/.*\.screens\.ts$/ },
    // Pins the artifact sandbox CSP's real-world permissiveness (a self-contained
    // artifact, a cdnjs-dependent one, a multi-page bundle) against real fixture
    // content — see e2e/render-fidelity/. Deterministic DOM-marker + console-error
    // assertions, not pixel-diff screenshots (this repo's `screens` project is
    // capture-only for exactly that flakiness reason). Hits a real external CDN
    // (cdnjs.cloudflare.com), so it's CI-triggered on a narrow path scope rather
    // than every PR — see .github/workflows/e2e-fidelity.yml.
    { name: "render-fidelity", testMatch: /render-fidelity\/.*\.spec\.ts$/ },
  ],
  // CI vs local serve the app differently, on purpose:
  //  • CI — build the SPA and let the API serve it (the production self-host path),
  //    so first paint is a deterministic static asset instead of an on-demand
  //    dev-server transform that stalls under CPU pressure (the paint-flake cause),
  //    and the auth cookie stays same-origin. One server, rebuilt fresh each run.
  //  • local — the two dev servers (API + vite), for HMR + warm-server reuse. Local
  //    has spare cores, so the dev-transform latency never bites here.
  webServer: isCI
    ? [
        {
          command: `rm -rf apps/api/.e2e-data && pnpm --filter @derive/web build && PORT=${API_PORT} DATA_DIR=.e2e-data DERIVE_MULTI_WORKSPACE=true DERIVE_WEB_ORIGIN=${ORIGIN} DERIVE_RATE_LIMIT=false pnpm --filter @derive/api start`,
          url: `${ORIGIN}/healthz`,
          cwd: "../..",
          // A full prod build (import-protection dominates) + API start on the free 2-vCPU
          // runner creeps toward the old 180s ceiling as the app grows — locally it's ~15s, but
          // under CI CPU pressure it occasionally overran and flaked. 300s is headroom, not a
          // real wait: on success the server is ready in well under a minute.
          timeout: 300_000,
          reuseExistingServer: false,
        },
      ]
    : [
        {
          command: `rm -rf apps/api/.e2e-data && PORT=${API_PORT} DATA_DIR=.e2e-data DERIVE_MULTI_WORKSPACE=true DERIVE_WEB_ORIGIN=${WEB} DERIVE_RATE_LIMIT=false pnpm --filter @derive/api dev`,
          url: `${ORIGIN}/healthz`,
          cwd: "../..",
          timeout: 60_000,
          reuseExistingServer: true,
        },
        {
          command: `DERIVE_API=${ORIGIN} pnpm --filter @derive/web dev --port ${WEB_PORT} --strictPort`,
          url: WEB,
          cwd: "../..",
          timeout: 120_000,
          reuseExistingServer: true,
        },
      ],
})
