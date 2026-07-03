import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { test } from "@playwright/test"
import { signUp } from "../helpers"

// Focused visual-QA capture for the nav rail's open/close control — the collapse
// trigger in the SidebarHeader — across collapsed/expanded × dark/light. Companion
// to dashboard.screens.ts (no artifact seed: this only frames the rail header).
// Self-skips unless SHOTS=1.
//   SHOTS=1 SHOT_OUT=/tmp/shots npx playwright test --project=screens sidebar
//
// Output dir: SHOT_OUT (default test-results/screens).

const OUT = process.env.SHOT_OUT ?? join(process.cwd(), "test-results", "screens")
const DESKTOP = { width: 1440, height: 900 }
const THEMES = ["dark", "light"] as const

test.use({ deviceScaleFactor: 2, viewport: DESKTOP })

test("capture the rail open/close control", async ({ page: p }) => {
  test.skip(!process.env.SHOTS, "visual-QA harness — run with SHOTS=1 --project=screens")
  test.setTimeout(120_000)
  mkdirSync(OUT, { recursive: true })

  await signUp(p)

  const settle = async (ms = 500) => {
    await p.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {})
    await p.evaluate(() => document.fonts.ready).catch(() => {})
    await p.waitForTimeout(ms)
  }
  const shot = async (
    name: string,
    clip: { x: number; y: number; width: number; height: number },
  ) => {
    await p.screenshot({ path: join(OUT, `${name}.png`), clip })
    console.log(`✓ ${name}`)
  }
  const menu = () => p.getByTestId("library-menu")
  const COLLAPSED = { x: 0, y: 0, width: 280, height: 360 }
  const EXPANDED = { x: 0, y: 0, width: 300, height: 300 }

  for (const theme of THEMES) {
    await p.evaluate((t) => localStorage.setItem("derive_theme", t), theme)
    // Force the collapsed state (the captures below open from collapsed) so the
    // run is order-independent regardless of the default.
    await p.evaluate(() => localStorage.setItem("derive.nav.collapsed", "1"))
    await p.goto("/")
    await settle()

    await shot(`rail-collapsed-${theme}`, COLLAPSED)

    await menu().hover()
    await p.waitForTimeout(900) // Radix tooltip default open delay (700ms)
    await shot(`rail-collapsed-hover-${theme}`, COLLAPSED)

    await menu().click()
    await settle(400)
    await shot(`rail-expanded-${theme}`, EXPANDED)

    // Hover the expanded trigger too — verify its rail-native hover chip.
    await menu().hover()
    await p.waitForTimeout(900)
    await shot(`rail-expanded-hover-${theme}`, EXPANDED)
  }
})
