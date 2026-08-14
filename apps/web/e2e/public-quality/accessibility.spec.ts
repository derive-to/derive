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
  test(`${surface.name} has no WCAG A/AA violations`, async ({ page }) => {
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
