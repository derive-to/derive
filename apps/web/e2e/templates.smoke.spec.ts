import type { Page } from "@playwright/test"
import { expect, publishArtifact, test } from "./fixtures"

// Tagging is the whole "offer" step: the shelf is artifacts tagged `template`.
async function tagAsTemplate(page: Page, shortId: string) {
  const res = await page.request.put(`/v1/artifacts/${shortId}/tags`, {
    data: { tags: ["template"] },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
}

// The public shelf lists artifacts that are listed publicly, not merely link-readable.
async function listPublicly(page: Page, shortId: string) {
  const res = await page.request.patch(`/v1/artifacts/${shortId}/access`, {
    data: { listed: "public" },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
}

const graphTemplate = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Research synthesis</title></head>
<body>
  <h1>Research synthesis</h1>
  <p>Frame the question, research two independent evidence lanes, then join them in one decision.</p>
  <script type="application/derive-facts" data-fact="bundle-manifest">
  {"schema":"derive.linked-bundle/v1","purpose":"Join independent evidence into one decision.","members":[],"diagrams":[{"id":"research-synthesis","title":"Research synthesis","type":"graph","nodes":[{"id":"frame","label":"Frame the question"},{"id":"market","label":"Research the market"},{"id":"customer","label":"Research the customer"},{"id":"decide","label":"Make the decision"}],"edges":[{"from":"frame","to":"market"},{"from":"frame","to":"customer"},{"from":"market","to":"decide"},{"from":"customer","to":"decide"}]}]}
  </script>
</body>
</html>`

test.describe("templates", () => {
  test("a tagged artifact appears on the workspace shelf and copies into the workspace", async ({
    owner: page,
  }) => {
    const shortId = await publishArtifact(
      page,
      "digest.html",
      "<h1>Weekly digest</h1><p>Week 33</p>",
      "text/html",
    )
    await tagAsTemplate(page, shortId)

    await page.goto("/templates")
    await expect(page.getByTestId("templates-shelf-workspace")).toBeVisible()
    await expect(page.getByTestId(`template-card-${shortId}`)).toBeVisible()
    await expect(page.getByTestId(`template-copy-${shortId}`)).toContainText("Make a copy")

    // The card's title is the template's own address; signed in, that is the workbench.
    await page.getByTestId(`template-open-${shortId}`).click()
    await expect(page).toHaveURL(new RegExp(`/templates/.*${shortId}`))
    await expect(page.getByText("Comments", { exact: true })).toBeVisible()

    await page.goto("/templates")
    await page.getByTestId(`template-copy-${shortId}`).click()
    await expect(page).toHaveURL(/\/artifacts\//)
    // The copy is a new artifact, not the template itself.
    expect(new URL(page.url()).pathname).not.toContain(shortId)
  })

  test("Ask your agent hands the artifact's short id to the local agent", async ({
    owner: page,
  }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
    const shortId = await publishArtifact(
      page,
      "plan.md",
      "# Implementation plan\n\nsteps",
      "text/markdown",
    )
    await tagAsTemplate(page, shortId)

    await page.goto("/templates")
    await page.getByTestId(`template-ask-${shortId}`).click()
    await expect(page.getByRole("heading", { name: /^Use / })).toBeVisible()
    await expect(page.getByTestId("artifact-source-editor")).toHaveCount(0)
    await page.getByTestId("template-agent-brief").fill("A plan for the payments migration.")
    await expect(page.getByTestId("template-agent-copy")).toContainText("Copy as prompt")
    await page.getByTestId("template-agent-copy").click()
    await expect(page.getByTestId("template-agent-copy")).toContainText(
      "Copied. Paste into your agent.",
    )
    const handoff = await page.evaluate(() => navigator.clipboard.readText())
    expect(handoff).toContain(`Exact reference: ${shortId}`)
    expect(handoff).toContain("payments migration")
    expect(handoff).toContain(`derived_from: "${shortId}"`)
    expect(handoff).toContain("Use Derive's read tool")
    expect(handoff).toContain("read its matching Derive skill")
    expect(handoff).toContain("validate that protocol before publishing")
    expect(new URL(page.url()).pathname).toBe("/templates")
  })

  test("a graph uses the ordinary template copy and shared Fill path", async ({ owner: page }) => {
    const shortId = await publishArtifact(
      page,
      "research-synthesis.html",
      graphTemplate,
      "text/html",
    )
    await tagAsTemplate(page, shortId)

    await page.goto("/templates")
    const card = page.getByTestId(`template-card-${shortId}`)
    await expect(card).toBeVisible()
    await expect(card.getByText("Bundle", { exact: true })).toBeVisible()
    await expect(page.getByTestId(`template-copy-${shortId}`)).toContainText("Make a copy")
    await expect(page.getByTestId(`template-ask-${shortId}`)).toContainText("Ask your agent")

    await page.getByTestId(`template-copy-${shortId}`).click()
    await expect(page).toHaveURL(/\/artifacts\//)
    expect(new URL(page.url()).pathname).not.toContain(shortId)
    await expect(page.getByTestId("derived-banner")).toContainText("Derived from")
    await page.getByTestId("banner-fill").click()
    await expect(page.getByRole("heading", { name: "Fill with your work" })).toBeVisible()
    await expect(page.getByText("read its matching Derive skill", { exact: false })).toBeVisible()
    await expect(
      page.getByText("validate that protocol before publishing", { exact: false }),
    ).toBeVisible()
  })

  test("an untagged artifact is not a template", async ({ owner: page }) => {
    const tagged = await publishArtifact(page, "kit.md", "# Starter kit", "text/markdown")
    const untagged = await publishArtifact(page, "note.md", "# Just a note", "text/markdown")
    await tagAsTemplate(page, tagged)
    await page.goto("/templates")
    // The shelf has settled once the tagged one is on it; only then is absence meaningful.
    await expect(page.getByTestId(`template-card-${tagged}`)).toBeVisible()
    await expect(page.getByTestId(`template-card-${untagged}`)).toHaveCount(0)
  })
})

test.describe("templates, signed out", () => {
  test("the public shelf is readable, and Make a copy goes through sign-in keeping the template", async ({
    owner,
    browser,
  }) => {
    const shortId = await publishArtifact(owner, "brief.md", "# Launch brief", "text/markdown")
    await tagAsTemplate(owner, shortId)
    await listPublicly(owner, shortId)

    const anon = await browser.newContext()
    const page = await anon.newPage()
    try {
      await page.goto("/templates")
      // The chrome-light frame, not the workbench: sign-in, no workspace verbs.
      await expect(page.getByTestId("public-sign-in")).toBeVisible()
      await expect(page.getByTestId("templates-shelf-public")).toBeVisible()
      await expect(page.getByTestId(`template-card-${shortId}`)).toBeVisible()
      await expect(page.getByTestId("templates-new-blank")).toHaveCount(0)
      await expect(page.getByTestId("templates-create-existing")).toHaveCount(0)

      await page.getByTestId(`template-copy-${shortId}`).click()
      await expect(page).toHaveURL(/\/login\?/)
      // Sign-in returns to the template's own page with the copy intent intact.
      const returnTo = new URL(page.url()).searchParams.get("return_to") ?? ""
      expect(returnTo).toMatch(new RegExp(`^/templates/.*${shortId}\\?use=1$`))

      // Creating the account from here finishes the copy: the visitor lands on their own.
      await page.getByTestId("login-name").fill("Copier")
      await page.getByTestId("login-email").fill(`e2e-copier-${Date.now()}@example.com`)
      await page.getByTestId("login-password").fill("e2e-pass-1234")
      await page.getByTestId("login-submit").click()
      await expect(page).toHaveURL(/\/artifacts\//, { timeout: 15_000 })
      expect(new URL(page.url()).pathname).not.toContain(shortId)
    } finally {
      await anon.close()
    }
  })

  test("a template page presents the strip, and public footers lead to it", async ({
    owner,
    browser,
  }) => {
    const tagged = await publishArtifact(owner, "kit.md", "# Starter kit", "text/markdown")
    await tagAsTemplate(owner, tagged)
    const plain = await publishArtifact(owner, "note.md", "# Just a note", "text/markdown")

    const anon = await browser.newContext()
    const page = await anon.newPage()
    try {
      await page.goto(`/templates/${tagged}`)
      await expect(page.getByTestId("template-strip")).toBeVisible()
      await expect(page.getByTestId("public-make-your-own")).toHaveAttribute(
        "href",
        /return_to=%2Ftemplates%2F/,
      )
      await expect(page.getByTestId("public-start-from")).toHaveText("Browse templates")
      await page.getByTestId("template-ask-agent").click()
      await expect(page.getByRole("heading", { name: /^Use / })).toBeVisible()
      await page.keyboard.press("Escape")

      // The artifact address of a tagged artifact is the plain page; its footer is the
      // way to the template page.
      await page.goto(`/artifacts/${tagged}`)
      await expect(page.getByTestId("public-start-from")).toHaveText("Start from this template")
      await expect(page.getByTestId("template-strip")).toHaveCount(0)
      await page.getByTestId("public-start-from").click()
      await expect(page).toHaveURL(new RegExp(`/templates/.*${tagged}`))
      await expect(page.getByTestId("template-strip")).toBeVisible()

      // An untagged artifact offers a copy of itself, through sign-in.
      await page.goto(`/artifacts/${plain}`)
      await expect(page.getByTestId("public-start-from")).toHaveText("Start from this page")
      await expect(page.getByTestId("public-start-from")).toHaveAttribute(
        "href",
        /return_to=%2Fartifacts%2F[^&]*%3Fuse%3D1/,
      )
    } finally {
      await anon.close()
    }
  })
})
