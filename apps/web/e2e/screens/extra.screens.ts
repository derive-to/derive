import { Buffer } from "node:buffer"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"

// TEMPORARY capture harness for the design audit — screenshots the surfaces the
// main dashboard harness doesn't cover (login, welcome, settings, people, new,
// profile, share dialog, command palette, comment thread). Same contract as
// dashboard.screens.ts: self-skips unless SHOTS=1, writes to SHOT_OUT.

const OUT = process.env.SHOT_OUT ?? join(process.cwd(), "test-results", "screens")
const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844 }

test.use({ deviceScaleFactor: 2, viewport: DESKTOP })

const settle = async (p: Page, ms = 1200) => {
  await p.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {})
  await p.evaluate(() => document.fonts.ready).catch(() => {})
  await p.waitForTimeout(ms)
}

test("capture the remaining surfaces", async ({ page: p }) => {
  test.skip(!process.env.SHOTS, "visual-QA harness — run with SHOTS=1 --project=screens")
  test.setTimeout(300_000)
  mkdirSync(OUT, { recursive: true })

  const shot = async (name: string) => {
    await p.screenshot({ path: join(OUT, `${name}.png`) })
    console.log(`✓ ${name}`)
  }
  const setTheme = async (t: "dark" | "light") => {
    await p.evaluate((theme) => localStorage.setItem("derive_theme", theme), t)
    await p.reload()
    await settle(p)
  }

  // Signed-out login, both themes (theme default is dark).
  await p.goto("/login")
  await settle(p)
  await shot("login-dark-desktop")
  await setTheme("light")
  await shot("login-light-desktop")
  await setTheme("dark")

  // Mobile login (the aside collapses; the form carries the brand).
  await p.setViewportSize(MOBILE)
  await settle(p, 600)
  await shot("login-dark-mobile")
  await p.setViewportSize(DESKTOP)
  await settle(p, 400)

  // Hand-rolled signup so we can capture the signup mode + /welcome mid-flow.
  await p.getByTestId("login-toggle").click()
  await settle(p, 400)
  await shot("signup-dark-desktop")
  await p.getByTestId("login-name").fill("E2E Tester")
  await p.getByTestId("login-email").fill(`e2e+${crypto.randomUUID()}@derive.test`)
  await p.getByTestId("login-password").fill("e2e-pass-1234")
  await p.getByTestId("login-submit").click()
  await expect(p).not.toHaveURL(/\/login/, { timeout: 15_000 })
  await expect(p.getByTestId("welcome-skip")).toBeVisible()
  // Wait for real content (the pasteable prompt block), not just the route skeleton,
  // so the capture isn't a blank shimmer.
  await expect(p.getByTestId("welcome-prompt")).toBeVisible()
  await settle(p)
  await shot("welcome-dark-desktop")
  await p.getByTestId("welcome-skip").click()
  await expect(p.getByTestId("library-menu")).toBeVisible()

  // One artifact so share/comments have a real target.
  const res = await p.request.post("/v1/artifacts", {
    multipart: {
      file: {
        name: "notes.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("# Notes\n\nA paragraph to anchor comments on.\n"),
      },
    },
  })
  if (!res.ok()) throw new Error(`publish failed: ${res.status()}`)
  const id = ((await res.json()) as { short_id: string }).short_id

  // Artifact with an open comment thread.
  await p.goto(`/artifacts/${id}`)
  await settle(p)
  await p.getByTestId("comment-new").click()
  await p.getByTestId("composer-input").fill("First pass looks good — one note on the intro.")
  await p.getByTestId("composer-submit").click()
  await expect(p.getByText("First pass looks good — one note on the intro.")).toBeVisible()
  await settle(p, 600)
  await shot("artifact-comments-dark-desktop")

  // Share dialog.
  await p.getByTestId("share-trigger").click()
  await settle(p, 600)
  await shot("share-dialog-dark-desktop")
  await p.keyboard.press("Escape")

  // Insights dialog — verifies the sm:max-w-2xl fix: the two-column stat/chart
  // layout must render roomy (672px), not clamped to 384px on desktop.
  await p
    .getByTestId("artifact-more")
    .click()
    .catch(() => {})
  await settle(p, 300)
  await p
    .getByTestId("artifact-insights")
    .click()
    .catch(() => {})
  await settle(p, 800)
  await shot("insights-dialog-dark-desktop")
  await p.keyboard.press("Escape")

  // Command palette.
  await p.keyboard.press("Meta+k")
  await p.waitForTimeout(600)
  await shot("palette-dark-desktop")
  await p.keyboard.press("Escape")

  // People + profile. Browse leads with who you follow; type to surface the wider
  // directory so the shot shows a populated list (and gives us a profile to drill into).
  await p.goto("/people")
  await p.getByTestId("people-search").fill("e")
  await settle(p)
  await shot("people-dark-desktop")
  const card = p.locator('[data-testid^="people-card-"]').first()
  if (await card.count()) {
    await card.click()
    await settle(p)
    await shot("profile-dark-desktop")
  }

  // New-artifact page.
  await p.goto("/new")
  await settle(p)
  await shot("new-dark-desktop")

  // Settings: dark + light desktop, dark mobile.
  await p.goto("/settings")
  await settle(p)
  await shot("settings-dark-desktop")
  await setTheme("light")
  await shot("settings-light-desktop")
  await setTheme("dark")
  await p.setViewportSize(MOBILE)
  await p.goto("/settings")
  await settle(p)
  await shot("settings-dark-mobile")
})
