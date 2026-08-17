import { createHash } from "node:crypto"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, devices } from "@playwright/test"

// Keep this quality suite isolated from the app E2E servers and from parallel
// worktrees. The inputs are production builds, not development transforms.
const worktreeDir = dirname(fileURLToPath(import.meta.url))
const portSlot =
  parseInt(createHash("sha1").update(worktreeDir).digest("hex").slice(0, 4), 16) % 600
const SITE_PORT = Number(process.env.PW_PUBLIC_SITE_PORT ?? 9100 + portSlot)
const DOCS_PORT = Number(process.env.PW_PUBLIC_DOCS_PORT ?? 9700 + portSlot)

export default defineConfig({
  testDir: "./e2e/public-quality",
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never", outputFolder: "playwright-report-public" }]]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report-public" }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: [
    {
      command: `node apps/web/e2e/public-quality/static-server.mjs apps/web/dist/client ${SITE_PORT}`,
      url: `http://127.0.0.1:${SITE_PORT}/site/index.html`,
      cwd: "../..",
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `node apps/web/e2e/public-quality/static-server.mjs apps/docs/dist ${DOCS_PORT}`,
      url: `http://127.0.0.1:${DOCS_PORT}/`,
      cwd: "../..",
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
})
