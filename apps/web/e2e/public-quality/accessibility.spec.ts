import { createHash } from "node:crypto"
import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

const siteOrigin = `http://127.0.0.1:${Number(process.env.PW_PUBLIC_SITE_PORT ?? 9100 + portSlot())}`
const docsOrigin = `http://127.0.0.1:${Number(process.env.PW_PUBLIC_DOCS_PORT ?? 9700 + portSlot())}`

function portSlot(): number {
  // Config and spec execute in separate processes; Playwright keeps cwd at
  // apps/web, which is the config directory and therefore the checkout identity.
  return parseInt(createHash("sha1").update(process.cwd()).digest("hex").slice(0, 4), 16) % 600
}

type Surface = {
  name: string
  url: string
  theme?: "dark" | "light"
  expectedStatus?: 200 | 404
}
const surfaces: Surface[] = [
  { name: "marketing home (dark)", url: `${siteOrigin}/site/index.html`, theme: "dark" },
  { name: "marketing home (light)", url: `${siteOrigin}/site/index.html`, theme: "light" },
  { name: "examples", url: `${siteOrigin}/site/examples.html` },
  { name: "pricing", url: `${siteOrigin}/site/pricing.html` },
  { name: "privacy", url: `${siteOrigin}/site/privacy.html` },
  { name: "security", url: `${siteOrigin}/security.html` },
  {
    name: "site 404",
    url: `${siteOrigin}/this-public-page-must-not-exist`,
    expectedStatus: 404,
  },
  { name: "docs home (dark)", url: `${docsOrigin}/`, theme: "dark" },
  { name: "docs home (light)", url: `${docsOrigin}/`, theme: "light" },
  { name: "docs quickstart", url: `${docsOrigin}/self-hosting/quickstart/`, theme: "dark" },
  { name: "docs access", url: `${docsOrigin}/concepts/access/`, theme: "dark" },
  {
    name: "docs 404",
    url: `${docsOrigin}/this-docs-page-must-not-exist`,
    theme: "dark",
    expectedStatus: 404,
  },
]

for (const surface of surfaces) {
  test(`${surface.name} has no axe-detectable WCAG A/AA violations`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" })
    if (surface.theme) {
      await page.emulateMedia({ colorScheme: surface.theme })
      await page.addInitScript((theme) => {
        localStorage.setItem("derive-theme", theme)
        localStorage.setItem("starlight-theme", theme)
      }, surface.theme)
    }

    const response = await page.goto(surface.url, { waitUntil: "networkidle" })
    expect(response, `No response for ${surface.url}`).not.toBeNull()
    expect(response?.status(), `Unexpected response for ${surface.url}`).toBe(
      surface.expectedStatus ?? 200,
    )
    await page.evaluate(() => document.fonts.ready)

    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze()
    const details = violations
      .map(
        (violation) =>
          `${violation.id}: ${violation.help}\n${violation.nodes
            .map((node) => `  ${node.target.join(" ")} — ${node.failureSummary ?? ""}`)
            .join("\n")}`,
      )
      .join("\n\n")
    expect(violations, details).toEqual([])
  })
}

test("marketing skip link moves focus to the primary content", async ({ page }) => {
  await page.goto(`${siteOrigin}/site/index.html`)
  await page.keyboard.press("Tab")
  const skip = page.getByRole("link", { name: "Skip to content" })
  await expect(skip).toBeFocused()
  await expect(skip).toBeVisible()
  await page.keyboard.press("Enter")
  await expect(page.locator("#main-content")).toBeFocused()
})

// Every public page is meant to carry the same shell. Asserting it per page is
// what stops one of them drifting back to its own navigation.
// The sign-in source is the one value the shell varies on purpose: signup
// attribution is a pinned, deliberately small set, not ambient click tracking.
const marketingPages = [
  { path: "/site/index.html", current: null, signin: "nav_signin" },
  { path: "/site/pricing.html", current: "/pricing", signin: "nav_signin" },
  { path: "/site/examples.html", current: "/examples", signin: "examples_signin" },
  { path: "/site/privacy.html", current: null, signin: "nav_signin" },
  { path: "/security.html", current: null, signin: "nav_signin" },
]

for (const { path, current, signin } of marketingPages) {
  test(`marketing shell is consistent on ${path}`, async ({ page }, testInfo) => {
    await page.goto(`${siteOrigin}${path}`)

    const nav = page.locator("nav.site-nav")
    await expect(nav).toBeVisible()

    // The same markup ships everywhere; below 480px the shell shows only the
    // sign-in action and leaves the rest to each page's footer. Match on href so
    // the assertion holds whether or not the link is currently displayed.
    const compact = testInfo.project.name === "mobile"
    for (const href of [
      "https://docs.derive.to/",
      "/examples",
      "/pricing",
      "https://github.com/derive-to/derive",
    ]) {
      const link = nav.locator(`a[href="${href}"]`)
      await expect(link).toHaveCount(1)
      if (!compact) await expect(link).toBeVisible()
    }
    await expect(nav.getByRole("link", { name: /Sign in to Beta/ })).toBeVisible()
    await expect(nav.getByRole("link", { name: /Sign in to Beta/ })).toHaveAttribute(
      "href",
      `/login?src=${signin}`,
    )

    // The active page marks itself, and only itself.
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(current ? 1 : 0)
    if (current)
      await expect(nav.locator(`a[href="${current}"]`)).toHaveAttribute("aria-current", "page")

    // The shared container must never push the page sideways.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true)

    // Content clears the fixed navigation rather than hiding beneath it.
    const overlap = await page.evaluate(() => {
      const main = document.querySelector("#main-content")
      const bar = document.querySelector("nav.site-nav")
      if (!main || !bar) return null
      return main.getBoundingClientRect().top - bar.getBoundingClientRect().bottom
    })
    expect(overlap).not.toBeNull()
    if (path !== "/site/index.html") expect(overlap).toBeGreaterThanOrEqual(0)
  })
}

test("marketing theme control cycles and is remembered", async ({ page }) => {
  await page.goto(`${siteOrigin}/site/pricing.html`)
  const toggle = page.locator("[data-theme-toggle]")

  await expect(toggle).toHaveAttribute("data-mode", "dark")
  await expect(page.locator("html")).toHaveClass(/dark/)

  await toggle.click()
  await expect(toggle).toHaveAttribute("data-mode", "light")
  await expect(page.locator("html")).toHaveClass(/light/)

  // The choice is shared across the marketing pages, not stored per page.
  await page.goto(`${siteOrigin}/security.html`)
  await expect(page.locator("html")).toHaveClass(/light/)
  await expect(page.locator("[data-theme-toggle]")).toHaveAttribute("data-mode", "light")
})

test("marketing skip link works on a page that had no navigation before", async ({ page }) => {
  await page.goto(`${siteOrigin}/security.html`)
  await page.keyboard.press("Tab")
  const skip = page.getByRole("link", { name: "Skip to content" })
  await expect(skip).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.locator("#main-content")).toBeFocused()
})

test("docs search loads the local browser index", async ({ page }) => {
  await page.goto(`${docsOrigin}/`)
  await page.locator("[data-search-open]").first().click()
  const search = page.getByRole("combobox", { name: "Search documentation" })
  await expect(search).toHaveAttribute("aria-expanded", "true")
  await search.fill("self-host")
  await expect(page.locator('.search-results a[href="/self-hosting/quickstart/"]')).toBeVisible()
  await expect(page.locator(".search-result-section").first()).not.toBeEmpty()
  await expect(page.getByRole("option").first()).toHaveAttribute("aria-selected", "true")
  await expect(search).toHaveAttribute("aria-activedescendant", /docs-search-result-\d+/)
  await expect(page.locator("#search-status")).not.toContainText("could not load")

  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze()
  expect(violations).toEqual([])
})

test("docs pages expose and copy their canonical Markdown", async ({ context, page }, testInfo) => {
  const markdown = await page.request.get(`${docsOrigin}/start/first-artifact.md`)
  expect(markdown.ok()).toBe(true)
  expect(markdown.headers()["content-type"]).toContain("text/markdown")
  expect(await markdown.text()).toContain("# Publish your first artifact")

  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: docsOrigin })
  await page.goto(`${docsOrigin}/start/first-artifact/`)
  await expect(page.locator('link[rel="alternate"][type="text/markdown"]')).toHaveAttribute(
    "href",
    "/start/first-artifact.md",
  )

  const copy = page.locator("[data-copy-page]:visible").first()
  await copy.click()
  await expect(copy).toHaveText("Copied")
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "# Publish your first artifact",
  )

  if (testInfo.project.name === "mobile") {
    const outline = page.locator(".mobile-page-tools details")
    await outline.getByText("On this page").click()
    await expect(outline.getByRole("link", { name: "Make the artifact durable" })).toBeVisible()
  }
})

test("docs table of contents tracks the visible section", async ({ page }) => {
  await page.goto(`${docsOrigin}/concepts/access/`)

  const firstLink = page.locator('[data-toc-link="choose-an-audience"]').first()
  const secondLink = page.locator('[data-toc-link="understand-workspace-roles"]').first()
  await expect(firstLink).toHaveAttribute("aria-current", "location")

  await page.locator("#understand-workspace-roles").evaluate((heading) => {
    document.documentElement.style.scrollBehavior = "auto"
    window.scrollTo(0, window.scrollY + heading.getBoundingClientRect().top - 100)
  })

  await expect(secondLink).toHaveAttribute("aria-current", "location")
  await expect(firstLink).not.toHaveAttribute("aria-current")
})
