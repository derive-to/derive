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

test("marketing mobile menu exposes the same primary navigation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile navigation is hidden on wider screens")
  await page.goto(`${siteOrigin}/site/index.html`)

  const menu = page.locator(".mobile-nav")
  await menu.locator("summary").click()
  await expect(menu.getByRole("link", { name: /Docs/ })).toBeVisible()
  await expect(menu.getByRole("link", { name: "Examples" })).toBeVisible()
  await expect(menu.getByRole("link", { name: "Pricing" })).toBeVisible()
  await expect(menu.getByRole("link", { name: /GitHub/ })).toBeVisible()
  await expect(menu.getByRole("link", { name: /Sign in/ })).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(menu).not.toHaveAttribute("open")
  await expect(menu.locator("summary")).toBeFocused()
})

test("marketing walkthrough lets readers inspect each artifact version", async ({ page }) => {
  await page.goto(`${siteOrigin}/site/index.html`)

  const walkthrough = page.locator("[data-home-demo]")
  const firstVersion = page.locator('[data-demo-version="1"]')
  await firstVersion.click()

  await expect(walkthrough).toHaveAttribute("data-version", "1")
  await expect(firstVersion).toHaveAttribute("aria-pressed", "true")
  await expect(walkthrough.getByRole("heading", { name: "OSC-8 Synthesizer" })).toBeVisible()
  await expect(walkthrough.getByText("No comments yet.")).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
    ),
  ).toBe(true)
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
