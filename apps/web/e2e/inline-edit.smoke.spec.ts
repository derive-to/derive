import type { Page } from "@playwright/test"
import { expect, openArtifact, publishArtifact, test } from "./fixtures"

/**
 * Inline editing: the mode, end to end, through the real sandboxed frame.
 *
 * Its own file rather than a line in the smoke gate, per the e2e README — this is
 * one surface in depth. It exists because the ENGINE (quote resolution, the
 * projection offset map, the edits route) is covered by unit tests while the part
 * that actually breaks is the MODE: entering it, what a save does to it, and the
 * three ways of leaving with unsaved work. None of that is reachable from a
 * node-environment unit test, so before this file a regression in the state
 * machine shipped without failing anything.
 *
 * Assertions end at the API wherever content is concerned. A cleared bar only
 * proves the client believes it saved; reading the version back proves it did.
 */

const DOC = "<h1>Runbook</h1><p id=one>First paragraph.</p><p id=two>Second paragraph.</p>"

/** Publish an HTML artifact and open it with the workbench interactive. */
async function seed(page: Page) {
  const shortId = await publishArtifact(page, "doc.html", DOC, "text/html")
  await openArtifact(page, shortId)
  return shortId
}

/** The artifact's rendered document — a real cross-origin sandboxed iframe. */
const doc = (page: Page) => page.frameLocator("iframe[title]")

async function enterEditMode(page: Page) {
  await page.getByTestId("artifact-inline-edit").click()
  await expect(page.getByTestId("inline-edit-bar")).toBeVisible()
}

/**
 * Append text to a paragraph in the frame: click it (which is what arms the block),
 * jump to the end, and type. An append is the one edit whose expected result is
 * unambiguous no matter how the differ word-snaps it.
 */
async function appendToParagraph(page: Page, id: string, text: string) {
  await doc(page).locator(`#${id}`).click()
  await page.keyboard.press("End")
  await page.keyboard.type(text)
}

const contentOf = async (page: Page, shortId: string) => {
  const res = await page.request.get(`/v1/artifacts/${shortId}/content`)
  expect(res.ok(), `content fetch failed: ${res.status()}`).toBeTruthy()
  return res.text()
}
const versionOf = async (page: Page, shortId: string) => {
  const res = await page.request.get(`/v1/artifacts/${shortId}`)
  return ((await res.json()) as { current_version: number }).current_version
}

test("type in the document and save — the edit lands in the stored source", async ({ owner }) => {
  const shortId = await seed(owner)
  await enterEditMode(owner)

  await appendToParagraph(owner, "one", " Amended.")
  // The strip counts the touched block, which is how the user knows anything took.
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("1 unsaved change")

  await owner.getByTestId("inline-edit-save").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()

  await expect(async () => {
    expect(await versionOf(owner, shortId)).toBe(2)
    const html = await contentOf(owner, shortId)
    expect(html).toContain("First paragraph. Amended.")
    // Surgical: the rest of the source is untouched, markup included.
    expect(html).toContain("<p id=two>Second paragraph.</p>")
    expect(html).toContain("<h1>Runbook</h1>")
  }).toPass({ timeout: 10_000 })
})

test("discard reverts the text and publishes nothing", async ({ owner }) => {
  const shortId = await seed(owner)
  await enterEditMode(owner)

  await appendToParagraph(owner, "one", " Throwaway.")
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("1 unsaved change")

  await owner.getByTestId("inline-edit-discard").click()
  // Back to the invitation, and the document reads as it did before.
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("any text to change it")
  await expect(doc(owner).locator("#one")).toHaveText("First paragraph.")
  expect(await versionOf(owner, shortId)).toBe(1)
})

test("escape leaves a clean session, and asks before dropping a dirty one", async ({ owner }) => {
  await seed(owner)
  await enterEditMode(owner)

  // Clean: Escape is just "leave".
  await owner.keyboard.press("Escape")
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()

  // Dirty, and the caret is still in the block. Escape is two steps by design: the
  // first drops the caret and keeps everything (the "get this cursor out of my way"
  // reflex must not be a destructive keystroke)...
  await enterEditMode(owner)
  await appendToParagraph(owner, "one", " Pending.")
  await owner.keyboard.press("Escape")
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("1 unsaved change")
  await expect(owner.getByTestId("inline-edit-exit-confirm")).toBeHidden()

  // ...and only the second asks about the mode itself.
  await owner.keyboard.press("Escape")
  await expect(owner.getByTestId("inline-edit-exit-confirm")).toBeVisible()

  // Cancelling keeps both the session and the text.
  await owner.getByTestId("confirm-dialog-cancel").click()
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("1 unsaved change")
  // Wait for the dialog to be fully gone: pressing Escape into a layer that is still
  // animating out is caught by that layer, not the page.
  await expect(owner.getByTestId("inline-edit-exit-confirm")).toBeHidden()

  // Confirming leaves and reverts. (Cancel returned focus to the page, not the
  // block, so one press reaches the mode this time.)
  await owner.keyboard.press("Escape")
  await owner.getByTestId("inline-edit-exit-confirm").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()
  await expect(doc(owner).locator("#one")).toHaveText("First paragraph.")
})

test("navigating away with unsaved edits is guarded, not silent", async ({ owner }) => {
  const shortId = await seed(owner)
  await enterEditMode(owner)
  await appendToParagraph(owner, "one", " Unsaved.")

  // In-app navigation is intercepted by the router blocker.
  await owner.getByTestId("sidebar-all").click()
  await expect(owner.getByTestId("inline-edit-leave-confirm")).toBeVisible()
  await expect(owner).toHaveURL(new RegExp(shortId))

  // Cancel keeps us on the document with the edit intact.
  await owner.getByTestId("confirm-dialog-cancel").click()
  await expect(owner).toHaveURL(new RegExp(shortId))
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("1 unsaved change")

  // Confirming discards and lets the navigation through.
  await owner.getByTestId("sidebar-all").click()
  await owner.getByTestId("inline-edit-leave-confirm").click()
  await expect(owner).not.toHaveURL(new RegExp(shortId))
  expect(await versionOf(owner, shortId)).toBe(1)
})
