import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Page } from "@playwright/test"
import { zipSync } from "fflate"
import { expect, publishArtifact, test } from "../fixtures"

// Pins what the artifact sandbox's serve-time CSP (apps/api/src/lib/http.ts's
// RAW_HEADERS) actually permits, against REAL fixture content per tier — so a
// future hardening pass (e.g. adding a script-src/connect-src directive, which
// today's `sandbox` CSP has none of) breaks a deterministic test here instead of
// silently degrading every Claude/ChatGPT-exported artifact that leans on an
// external CDN. Fixtures live in ./fixtures — read them from disk rather than
// inlining, so they're real files a human can open and eyeball too.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures")

// Collects console errors + uncaught page errors during a navigation — half of
// the CSP-permissiveness pin: a blocked subresource often logs to console even
// when it doesn't throw a catchable JS exception the page script could react to.
async function withErrorCapture(page: Page, fn: () => Promise<void>): Promise<string[]> {
  const errors: string[] = []
  const onConsole = (msg: { type(): string; text(): string }) => {
    if (msg.type() === "error") errors.push(msg.text())
  }
  const onPageError = (err: Error) => errors.push(err.message)
  page.on("console", onConsole)
  page.on("pageerror", onPageError)
  try {
    await fn()
  } finally {
    page.off("console", onConsole)
    page.off("pageerror", onPageError)
  }
  return errors
}

test.describe("render fidelity — pinning what the sandbox CSP permits", () => {
  test("viewer fails closed when a script throws before meaningful content", async ({
    browser,
    owner: page,
  }) => {
    const html = readFileSync(join(FIXTURES, "startup-blocked.html"), "utf8")
    const shortId = await publishArtifact(page, "index.html", html, "text/html")

    await page.goto(`/artifacts/${shortId}`)
    await expect(page.getByText("Artifact script stopped")).toBeVisible()
    await expect(page.getByTestId("render-degraded")).toHaveCount(0)
    await expect(page.getByTestId("render-retry")).toBeVisible()

    const publicContext = await browser.newContext()
    const publicPage = await publicContext.newPage()
    try {
      await publicPage.goto(`/artifacts/${shortId}`)
      await expect(publicPage.getByText("This artifact couldn’t start")).toBeVisible()
      await expect(publicPage.getByTestId("render-degraded")).toHaveCount(0)
    } finally {
      await publicContext.close()
    }
  })

  test("viewer fails soft when an optional fallback throws after meaningful content", async ({
    browser,
    owner: page,
  }) => {
    const html = readFileSync(join(FIXTURES, "startup-fail-soft.html"), "utf8")
    const shortId = await publishArtifact(page, "index.html", html, "text/html")

    const wrapperErrors = await withErrorCapture(page, () => page.goto(`/artifacts/${shortId}`))
    expect(wrapperErrors).toEqual([])
    await expect(page.getByTestId("render-degraded")).toBeVisible()
    await expect(page.getByText("This artifact couldn’t start")).toHaveCount(0)

    const frame = page.locator('iframe[title="index"]')
    await expect(frame).toBeVisible()
    const artifact = page.frameLocator('iframe[title="index"]')
    await expect(artifact.locator("#rows tr")).toHaveCount(30)
    await artifact.locator("#control").click()
    await expect(artifact.locator("#count")).toHaveText("1")
    await page.getByTestId("render-degraded-dismiss").click()
    await expect(page.getByTestId("render-degraded")).toHaveCount(0)
    await expect(artifact.locator("#rows tr")).toHaveCount(30)

    // The public wrapper has its own chrome/layout path. Exercise the same shared
    // artifact anonymously so a workbench-only fix cannot masquerade as complete.
    const publicContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const publicPage = await publicContext.newPage()
    try {
      await publicPage.goto(`/artifacts/${shortId}`)
      await expect(publicPage.getByTestId("render-degraded")).toBeVisible()
      await expect(publicPage.getByText("This artifact couldn’t start")).toHaveCount(0)
      const publicArtifact = publicPage.frameLocator('iframe[title="index"]')
      await expect(publicArtifact.locator("#rows tr")).toHaveCount(30)
      await publicArtifact.locator("#control").click()
      await expect(publicArtifact.locator("#count")).toHaveText("1")
    } finally {
      await publicContext.close()
    }
  })

  test("tier 1: a fully self-contained artifact renders with zero console errors, inline script executes", async ({
    owner: page,
  }) => {
    const html = readFileSync(join(FIXTURES, "tier1-self-contained.html"), "utf8")
    const shortId = await publishArtifact(page, "index.html", html, "text/html")

    const errors = await withErrorCapture(page, async () => {
      await page.goto(`/raw/${shortId}/v/1/`)
      await page.waitForLoadState("networkidle")
    })
    expect(errors).toEqual([])

    // The marker set only after the inline <script> actually ran, not just that
    // the markup parsed.
    await expect(page.locator("html")).toHaveAttribute("data-tier1-script-ran", "true")
    await expect(page.getByTestId("tier1-increment")).toBeVisible()
    await page.getByTestId("tier1-increment").click()
    await expect(page.locator("#count")).toHaveText("1")
  })

  test("tier 2: a cdnjs-dependent artifact actually loads AND executes the CDN script (pins CSP permissiveness)", async ({
    owner: page,
  }) => {
    const html = readFileSync(join(FIXTURES, "tier2-cdn-dependent.html"), "utf8")
    const shortId = await publishArtifact(page, "index.html", html, "text/html")

    await page.goto(`/raw/${shortId}/v/1/`)
    // A real network fetch to cdnjs.cloudflare.com — slower and less predictable
    // than this app's own same-origin assets, so a generous timeout rather than
    // networkidle (Chart.js itself defers its first paint a tick after load).
    // This attribute is set ONLY after `new Chart(...)` returns without throwing —
    // a blocked/failed script load leaves it "false" (set eagerly) or absent
    // (script never ran at all), either way a hard, deterministic failure here,
    // not a pixel-diff comparison that a font-rendering difference could also trip.
    await expect(page.locator("html")).toHaveAttribute("data-tier2-chart-rendered", "true", {
      timeout: 15_000,
    })
    await expect(page.getByTestId("tier2-status")).toHaveText("OK: chart rendered")
  })

  test("tier 3: a multi-page bundle serves both pages and in-bundle relative links navigate correctly", async ({
    owner: page,
  }) => {
    const zip = zipSync({
      "index.html": readFileSync(join(FIXTURES, "tier3-bundle/index.html")),
      "about.html": readFileSync(join(FIXTURES, "tier3-bundle/about.html")),
    })
    const shortId = await publishArtifact(page, "site.zip", zip, "application/zip")

    await page.goto(`/raw/${shortId}/v/1/index.html`)
    await expect(page.getByTestId("tier3-home-heading")).toBeVisible()

    await page.getByTestId("tier3-nav-about").click()
    await expect(page.getByTestId("tier3-about-heading")).toBeVisible()

    await page.getByTestId("tier3-nav-home").click()
    await expect(page.getByTestId("tier3-home-heading")).toBeVisible()
  })
})
