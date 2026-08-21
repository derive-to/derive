import type { Page } from "@playwright/test"
import { expect, publishArtifact, test } from "./fixtures"

// Tagging is the whole "offer" step: the shelf is artifacts tagged `template`.
async function tagAsTemplate(page: Page, shortId: string) {
  const res = await page.request.put(`/v1/artifacts/${shortId}/tags`, {
    data: { tags: ["template"] },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
}

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
    expect(new URL(page.url()).pathname).toBe("/templates")
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
