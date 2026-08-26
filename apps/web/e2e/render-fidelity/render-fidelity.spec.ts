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
  test("an iframe-based visualization with an authored CSP reaches Ready", async ({
    owner: page,
  }) => {
    const html = readFileSync(join(FIXTURES, "startup-csp-visualization-shell.html"), "utf8")
    const shortId = await publishArtifact(page, "index.html", html, "text/html")

    const errors = await withErrorCapture(page, () => page.goto(`/artifacts/${shortId}`))
    expect(errors).toEqual([])
    await expect(page.getByTestId("render-degraded")).toHaveCount(0)
    await expect(page.getByText("This artifact couldn’t start")).toHaveCount(0)
    const artifact = page.frameLocator('iframe[title="index"]')
    const generated = artifact.frameLocator('iframe[title="Generated visualization"]')
    await expect(
      generated.getByRole("heading", { name: "Generated visualization remains visible" }),
    ).toBeVisible()
  })

  test("viewer fails closed when a script throws before meaningful content", async ({
    browser,
    owner: page,
  }) => {
    const html = readFileSync(join(FIXTURES, "startup-blocked.html"), "utf8")
    const shortId = await publishArtifact(page, "index.html", html, "text/html")

    await page.goto(`/artifacts/${shortId}`)
    await expect(page.getByText("Artifact script stopped")).toBeVisible()
    await expect(page.getByTestId("render-degraded")).toHaveCount(0)
    // The generic 15s stuck-preview timer must not add an overlapping second
    // recovery card after the specific runtime failure already owns this state.
    await page.waitForTimeout(16_000)
    await expect(page.getByText("Preview didn’t load")).toHaveCount(0)
    await expect(page.getByTestId("render-retry")).toHaveCount(1)

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

  test("Ready never returns to Blocked for a late legacy loading-phase error", async ({
    owner: page,
  }) => {
    const html = readFileSync(join(FIXTURES, "startup-stale-loading-error.html"), "utf8")
    const shortId = await publishArtifact(page, "index.html", html, "text/html")

    await page.goto(`/artifacts/${shortId}`)
    await expect(page.getByTestId("render-degraded")).toBeVisible()
    await expect(page.getByText("Artifact script stopped")).toHaveCount(0)
    const artifact = page.frameLocator('iframe[title="index"]')
    await expect(
      artifact.getByRole("heading", { name: "Useful content reached Ready" }),
    ).toBeVisible()
    await artifact.locator("#control").click()
    await expect(artifact.locator("#count")).toHaveText("1")
  })

  test("viewer waits through iframe load, then degrades after delayed meaningful paint", async ({
    browser,
    owner: page,
  }) => {
    const html = readFileSync(join(FIXTURES, "startup-delayed-ready.html"), "utf8")
    const shortId = await publishArtifact(page, "index.html", html, "text/html")

    await page.goto(`/artifacts/${shortId}`)
    await expect(page.getByText("Loading preview…")).toBeVisible()
    await expect(page.getByTestId("render-degraded")).toHaveCount(0)
    await expect(page.getByTestId("render-degraded")).toBeVisible()
    const artifact = page.frameLocator('iframe[title="index"]')
    await expect(artifact.locator("#rows tr")).toHaveCount(30)
    await artifact.locator("#control").click()
    await expect(artifact.locator("#count")).toHaveText("1")

    const publicContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const publicPage = await publicContext.newPage()
    try {
      await publicPage.goto(`/artifacts/${shortId}`)
      await expect(publicPage.getByText("Loading preview…")).toBeVisible()
      await expect(publicPage.getByTestId("render-degraded")).toBeVisible()
      const publicArtifact = publicPage.frameLocator('iframe[title="index"]')
      await expect(publicArtifact.locator("#rows tr")).toHaveCount(30)
    } finally {
      await publicContext.close()
    }
  })

  for (const action of ["throw", "reject"] as const) {
    test(`post-ready ${action} failure degrades without replacing useful controls`, async ({
      owner: page,
    }) => {
      const html = readFileSync(join(FIXTURES, "startup-post-ready-actions.html"), "utf8")
      const shortId = await publishArtifact(page, "index.html", html, "text/html")

      await page.goto(`/artifacts/${shortId}`)
      const artifact = page.frameLocator('iframe[title="index"]')
      await expect(
        artifact.getByRole("heading", { name: "Useful controls reached Ready" }),
      ).toBeVisible()
      await artifact.locator(`#${action}-control`).click()
      await expect(page.getByTestId("render-degraded")).toBeVisible()
      await expect(page.getByText("Artifact script stopped")).toHaveCount(0)
      await artifact.locator("#working-control").click()
      await expect(artifact.locator("#count")).toHaveText("1")
    })
  }

  test("pre-content storage and required-script failures keep editor repair guidance", async ({
    owner: page,
  }) => {
    const cases = [
      {
        fixture: "startup-storage-blocked.html",
        title: "Browser storage isn’t available here",
        repair: "derive.shared",
      },
      {
        fixture: "startup-required-script-blocked.html",
        title: "Artifact script stopped",
        repair: "Check the source and republish",
      },
    ]

    for (const scenario of cases) {
      const html = readFileSync(join(FIXTURES, scenario.fixture), "utf8")
      const shortId = await publishArtifact(page, "index.html", html, "text/html")
      await page.goto(`/artifacts/${shortId}`)
      await expect(page.getByText(scenario.title)).toBeVisible()
      await expect(page.getByText(scenario.repair, { exact: false })).toBeVisible()
      await expect(page.getByTestId("render-degraded")).toHaveCount(0)
      await expect(page.getByTestId("render-retry")).toBeVisible()
    }
  })

  for (const scenario of [
    { fixture: "startup-hidden-marker.html", label: "hidden readiness marker" },
    { fixture: "startup-hidden-rich-content.html", label: "hidden rich content" },
    { fixture: "startup-script-source-only.html", label: "script source text" },
  ]) {
    test(`${scenario.label} cannot turn a bootstrap failure into Ready`, async ({
      owner: page,
    }) => {
      const html = readFileSync(join(FIXTURES, scenario.fixture), "utf8")
      const shortId = await publishArtifact(page, "index.html", html, "text/html")

      await page.goto(`/artifacts/${shortId}`)
      await expect(page.getByText("Artifact script stopped")).toBeVisible()
      await expect(page.getByTestId("render-degraded")).toHaveCount(0)
      await expect(page.getByTestId("render-retry")).toHaveCount(1)
    })
  }

  test("nested iframe cannot forge the direct artifact runtime protocol", async ({
    owner: page,
  }) => {
    const html = readFileSync(join(FIXTURES, "startup-nested-frame-spoof.html"), "utf8")
    const shortId = await publishArtifact(page, "index.html", html, "text/html")

    await page.goto(`/artifacts/${shortId}`)
    const artifact = page.frameLocator('iframe[title="index"]')
    await expect(
      artifact.getByRole("heading", { name: "Direct artifact frame remains authoritative" }),
    ).toBeVisible()
    await page.waitForTimeout(1_000)
    await expect(page.getByTestId("render-degraded")).toHaveCount(0)
    await expect(page.getByText("Artifact script stopped")).toHaveCount(0)
    await artifact.locator("#control").click()
    await expect(artifact.locator("#count")).toHaveText("1")
  })

  test("a distinct post-ready failure reopens recovery after dismissal", async ({
    browser,
    owner: page,
  }) => {
    const html = readFileSync(join(FIXTURES, "startup-sequential-errors.html"), "utf8")
    const shortId = await publishArtifact(page, "index.html", html, "text/html")

    await page.goto(`/artifacts/${shortId}`)
    await expect(page.getByTestId("render-degraded")).toBeVisible()
    await page.getByTestId("render-degraded-dismiss").click()
    await expect(page.getByTestId("render-degraded")).toHaveCount(0)

    const artifact = page.frameLocator('iframe[title="index"]')
    await artifact.locator("#throw-control").click()
    await expect(page.getByTestId("render-degraded")).toBeVisible()
    await expect(
      page.getByText("A script failed after meaningful content", { exact: false }),
    ).toBeVisible()
    await artifact.locator("#working-control").click()
    await expect(artifact.locator("#count")).toHaveText("1")

    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const mobile = await mobileContext.newPage()
    try {
      await mobile.goto(`/artifacts/${shortId}`)
      await expect(mobile.getByTestId("render-degraded")).toContainText("resource-error")
      await mobile.getByTestId("render-degraded-dismiss").click()
      const mobileArtifact = mobile.frameLocator('iframe[title="index"]')
      await mobileArtifact.locator("#throw-control").click()
      await expect(mobile.getByTestId("render-degraded")).toContainText("script-error")
      await expect(mobile.getByTestId("render-degraded")).not.toContainText("resource-error")
    } finally {
      await mobileContext.close()
    }
  })

  test("visible meaningful content in an open shadow root reaches Ready", async ({
    owner: page,
  }) => {
    const html = readFileSync(join(FIXTURES, "startup-shadow-ready.html"), "utf8")
    const shortId = await publishArtifact(page, "index.html", html, "text/html")

    await page.goto(`/artifacts/${shortId}`)
    await expect(page.getByText("Loading preview…")).toHaveCount(0, { timeout: 5_000 })
    const artifact = page.frameLocator('iframe[title="index"]')
    await expect(artifact.locator("#host").locator("h1")).toHaveText("Shadow dashboard is ready")
    await artifact.locator("#host").locator("#control").click()
    await expect(artifact.locator("#host").locator("#count")).toHaveText("1")
  })

  test("a successfully loaded standalone image reaches Ready", async ({ owner: page }) => {
    const html = readFileSync(join(FIXTURES, "startup-loaded-image-ready.html"), "utf8")
    const shortId = await publishArtifact(page, "index.html", html, "text/html")

    await page.goto(`/artifacts/${shortId}`)
    await expect(page.getByText("Loading preview…")).toHaveCount(0, { timeout: 5_000 })
    const artifact = page.frameLocator('iframe[title="index"]')
    await expect(artifact.locator("#proof")).toBeVisible()
    await artifact.locator("#control").click()
    await expect(artifact.locator("#count")).toHaveText("1")
  })

  test("zero-area SVG cannot turn a bootstrap failure into Ready", async ({ owner: page }) => {
    const html = readFileSync(join(FIXTURES, "startup-zero-area-svg.html"), "utf8")
    const shortId = await publishArtifact(page, "index.html", html, "text/html")

    await page.goto(`/artifacts/${shortId}`)
    await expect(page.getByText("Artifact script stopped")).toBeVisible()
    await expect(page.getByTestId("render-degraded")).toHaveCount(0)
    await expect(page.getByTestId("render-retry")).toHaveCount(1)
  })

  test("meaningful paint after the generic timeout self-recovers to Ready", async ({
    owner: page,
  }) => {
    const html = readFileSync(join(FIXTURES, "startup-post-timeout-ready.html"), "utf8")
    const shortId = await publishArtifact(page, "index.html", html, "text/html")

    await page.goto(`/artifacts/${shortId}`)
    await expect(page.getByText("Preview didn’t load")).toBeVisible({ timeout: 16_000 })
    const artifact = page.frameLocator('iframe[title="index"]')
    await expect(
      artifact.getByRole("heading", { name: "Late content recovered automatically" }),
    ).toBeVisible({ timeout: 5_000 })
    await expect(page.getByText("Preview didn’t load")).toHaveCount(0)
    await artifact.locator("#control").click()
    await expect(artifact.locator("#count")).toHaveText("1")
  })

  test("degraded dismissal is scoped to one artifact instance", async ({ owner: page }) => {
    const html = readFileSync(join(FIXTURES, "startup-fail-soft.html"), "utf8")
    const firstId = await publishArtifact(page, "index.html", html, "text/html")
    const secondId = await publishArtifact(page, "index.html", html, "text/html")

    await page.goto(`/artifacts/${firstId}`)
    await expect(page.getByTestId("render-degraded")).toBeVisible()
    await page.getByTestId("render-degraded-dismiss").click()
    await expect(page.getByTestId("render-degraded")).toHaveCount(0)

    await page.goto(`/artifacts/${secondId}`)
    await expect(page.getByTestId("render-degraded")).toBeVisible()
    await expect(page.getByTestId("render-degraded")).toContainText("script-error")
  })

  for (const scenario of [
    { fixture: "startup-opacity-ancestor.html", label: "an opacity-zero ancestor" },
    { fixture: "startup-clipped-rich-content.html", label: "a zero-area clipping ancestor" },
    { fixture: "startup-collapsed-details.html", label: "collapsed details" },
  ]) {
    test(`${scenario.label} cannot expose hidden descendants as Ready`, async ({ owner: page }) => {
      const html = readFileSync(join(FIXTURES, scenario.fixture), "utf8")
      const shortId = await publishArtifact(page, "index.html", html, "text/html")

      await page.goto(`/artifacts/${shortId}`)
      await expect(page.getByText("Artifact script stopped")).toBeVisible()
      await expect(page.getByTestId("render-degraded")).toHaveCount(0)
      await expect(page.getByTestId("render-retry")).toHaveCount(1)
    })
  }

  test("exactly 80 visible non-whitespace characters reaches Ready", async ({ owner: page }) => {
    const html = readFileSync(join(FIXTURES, "startup-threshold-80.html"), "utf8")
    const shortId = await publishArtifact(page, "index.html", html, "text/html")

    await page.goto(`/artifacts/${shortId}`)
    const artifact = page.frameLocator('iframe[title="index"]')
    await artifact.locator("#control").click({ timeout: 5_000 })
    await expect(artifact.locator("#control")).toHaveAttribute("data-clicked", "true")
    await expect(page.getByTestId("render-retry")).toHaveCount(0)
  })

  test("79 visible non-whitespace characters plus an error stays Blocked", async ({
    owner: page,
  }) => {
    const html = readFileSync(join(FIXTURES, "startup-threshold-79-error.html"), "utf8")
    const shortId = await publishArtifact(page, "index.html", html, "text/html")

    await page.goto(`/artifacts/${shortId}`)
    await expect(page.getByText("Artifact script stopped")).toBeVisible()
    await expect(page.getByTestId("render-degraded")).toHaveCount(0)
    await expect(page.getByTestId("render-retry")).toHaveCount(1)
  })

  test("a visible second readiness marker wins over a hidden first marker", async ({
    owner: page,
  }) => {
    const html = readFileSync(join(FIXTURES, "startup-visible-second-marker.html"), "utf8")
    const shortId = await publishArtifact(page, "index.html", html, "text/html")

    await page.goto(`/artifacts/${shortId}`)
    await expect(page.getByTestId("render-degraded")).toBeVisible()
    const artifact = page.frameLocator('iframe[title="index"]')
    await artifact.locator("#control").click()
    await expect(artifact.locator("#count")).toHaveText("1")
  })

  for (const scenario of [
    { fixture: "startup-hidden-shadow-host.html", label: "an opacity-zero shadow host" },
    { fixture: "startup-hidden-loaded-image.html", label: "a hidden loaded image" },
    { fixture: "startup-broken-sized-image.html", label: "a broken image with layout dimensions" },
  ]) {
    test(`${scenario.label} cannot satisfy readiness`, async ({ owner: page }) => {
      const html = readFileSync(join(FIXTURES, scenario.fixture), "utf8")
      const shortId = await publishArtifact(page, "index.html", html, "text/html")

      await page.goto(`/artifacts/${shortId}`)
      await expect(page.getByText("Artifact script stopped")).toBeVisible()
      await expect(page.getByTestId("render-degraded")).toHaveCount(0)
      await expect(page.getByTestId("render-retry")).toHaveCount(1)
    })
  }

  test("attribute-only visibility after timeout self-recovers to Ready", async ({
    owner: page,
  }) => {
    const html = readFileSync(
      join(FIXTURES, "startup-attribute-visible-after-timeout.html"),
      "utf8",
    )
    const shortId = await publishArtifact(page, "index.html", html, "text/html")

    await page.goto(`/artifacts/${shortId}`)
    await expect(page.getByText("Preview didn’t load")).toBeVisible({ timeout: 16_000 })
    const artifact = page.frameLocator('iframe[title="index"]')
    await expect(
      artifact.getByRole("heading", { name: "Attribute-only recovery reached Ready" }),
    ).toBeVisible({ timeout: 5_000 })
    await expect(page.getByText("Preview didn’t load")).toHaveCount(0)
    await artifact.locator("#control").click()
    await expect(artifact.locator("#count")).toHaveText("1")
  })

  for (const scenario of [
    { fixture: "startup-aria-hidden-ancestor.html", label: "an aria-hidden ancestor" },
    { fixture: "startup-visibility-hidden-ancestor.html", label: "a visibility-hidden ancestor" },
    { fixture: "startup-display-none-ancestor.html", label: "a display-none ancestor" },
  ]) {
    test(`${scenario.label} keeps descendant rich content Blocked`, async ({ owner: page }) => {
      const html = readFileSync(join(FIXTURES, scenario.fixture), "utf8")
      const shortId = await publishArtifact(page, "index.html", html, "text/html")
      await page.goto(`/artifacts/${shortId}`)
      await expect(page.getByText("Artifact script stopped")).toBeVisible()
      await expect(page.getByTestId("render-degraded")).toHaveCount(0)
      await expect(page.getByTestId("render-retry")).toHaveCount(1)
    })
  }

  test("an open details table reaches Ready and remains usable", async ({ owner: page }) => {
    const html = readFileSync(join(FIXTURES, "startup-open-details-ready.html"), "utf8")
    const shortId = await publishArtifact(page, "index.html", html, "text/html")
    await page.goto(`/artifacts/${shortId}`)
    const artifact = page.frameLocator('iframe[title="index"]')
    await artifact.locator("#control").click({ timeout: 5_000 })
    await expect(artifact.locator("#count")).toHaveText("1")
    await expect(page.getByTestId("render-retry")).toHaveCount(0)
  })

  test("a loaded image inside an open shadow root reaches Ready", async ({ owner: page }) => {
    const html = readFileSync(join(FIXTURES, "startup-shadow-image-ready.html"), "utf8")
    const shortId = await publishArtifact(page, "index.html", html, "text/html")
    await page.goto(`/artifacts/${shortId}`)
    const artifact = page.frameLocator('iframe[title="index"]')
    await expect(artifact.locator("#host").locator("#proof")).toBeVisible()
    await artifact.locator("#host").locator("#control").click({ timeout: 5_000 })
    await expect(artifact.locator("#host").locator("#count")).toHaveText("1")
    await expect(page.getByTestId("render-retry")).toHaveCount(0)
  })

  test("a dismissed degraded warning returns after a full reload", async ({ owner: page }) => {
    const html = readFileSync(join(FIXTURES, "startup-fail-soft.html"), "utf8")
    const shortId = await publishArtifact(page, "index.html", html, "text/html")
    await page.goto(`/artifacts/${shortId}`)
    await expect(page.getByTestId("render-degraded")).toBeVisible()
    await page.getByTestId("render-degraded-dismiss").click()
    await expect(page.getByTestId("render-degraded")).toHaveCount(0)
    await page.reload()
    await expect(page.getByTestId("render-degraded")).toBeVisible()
    await expect(page.frameLocator('iframe[title="index"]').locator("#rows tr")).toHaveCount(30)
  })

  test("Retry on a degraded artifact creates one fresh usable iframe", async ({ owner: page }) => {
    const html = readFileSync(join(FIXTURES, "startup-fail-soft.html"), "utf8")
    const shortId = await publishArtifact(page, "index.html", html, "text/html")
    await page.goto(`/artifacts/${shortId}`)
    const artifact = page.frameLocator('iframe[title="index"]')
    await artifact.locator("#control").click()
    await expect(artifact.locator("#count")).toHaveText("1")
    await page.getByTestId("render-retry").click()
    await expect(page.locator('iframe[title="index"]')).toHaveCount(1)
    await expect(page.getByTestId("render-degraded")).toBeVisible()
    await expect(artifact.locator("#count")).toHaveText("0")
    await artifact.locator("#control").click()
    await expect(artifact.locator("#count")).toHaveText("1")
  })

  test("two blocked Retry attempts never duplicate recovery or iframes", async ({
    owner: page,
  }) => {
    const html = readFileSync(join(FIXTURES, "startup-blocked.html"), "utf8")
    const shortId = await publishArtifact(page, "index.html", html, "text/html")
    await page.goto(`/artifacts/${shortId}`)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(page.getByText("Artifact script stopped")).toBeVisible()
      await page.getByTestId("render-retry").click()
      await expect(page.locator('iframe[title="index"]')).toHaveCount(1)
      await expect(page.getByTestId("render-retry")).toHaveCount(1)
      await expect(page.getByText("Preview didn’t load")).toHaveCount(0)
    }
  })

  test("navigating from Blocked to a clean sibling clears blocking recovery", async ({
    owner: page,
  }) => {
    const blocked = await publishArtifact(
      page,
      "index.html",
      readFileSync(join(FIXTURES, "startup-blocked.html"), "utf8"),
      "text/html",
    )
    const clean = await publishArtifact(
      page,
      "index.html",
      readFileSync(join(FIXTURES, "startup-threshold-80.html"), "utf8"),
      "text/html",
    )
    await page.goto(`/artifacts/${blocked}`)
    await expect(page.getByText("Artifact script stopped")).toBeVisible()
    await page.goto(`/artifacts/${clean}`)
    await expect(page.getByTestId("render-retry")).toHaveCount(0)
    const artifact = page.frameLocator('iframe[title="index"]')
    await artifact.locator("#control").click({ timeout: 5_000 })
    await expect(artifact.locator("#control")).toHaveAttribute("data-clicked", "true")
  })

  test("navigating from Degraded to a clean sibling clears the warning rail", async ({
    owner: page,
  }) => {
    const degraded = await publishArtifact(
      page,
      "index.html",
      readFileSync(join(FIXTURES, "startup-fail-soft.html"), "utf8"),
      "text/html",
    )
    const clean = await publishArtifact(
      page,
      "index.html",
      readFileSync(join(FIXTURES, "startup-open-details-ready.html"), "utf8"),
      "text/html",
    )
    await page.goto(`/artifacts/${degraded}`)
    await expect(page.getByTestId("render-degraded")).toBeVisible()
    await page.goto(`/artifacts/${clean}`)
    await expect(page.getByTestId("render-degraded")).toHaveCount(0)
    const artifact = page.frameLocator('iframe[title="index"]')
    await artifact.locator("#control").click({ timeout: 5_000 })
    await expect(artifact.locator("#count")).toHaveText("1")
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
