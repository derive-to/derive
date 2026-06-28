import { Buffer } from "node:buffer"
import type { Page } from "@playwright/test"
import { expect, publishArtifact, test } from "../fixtures"

// The 3-way merge UX end-to-end: a disjoint concurrent edit merges silently on
// publish (zero UI), while an overlapping one opens the in-flow resolver — across
// every resolution (use current / use mine / hand-edit), multiple conflicts at
// once, and a re-conflict when someone publishes again mid-resolve. A small
// three-paragraph doc lets us target disjoint vs overlapping blocks precisely
// (markdown merges block by block).
const BASE = "alpha\n\nbeta\n\ngamma\n"

// Land a new version straight through the authenticated API — stands in for a
// teammate (or your agent) publishing while you have the editor open. Retried
// because a fresh e2e sqlite DB can briefly lock under the page's concurrent SSE
// writes (the same race the repo's publishArtifact helper guards against); a 500
// here is contention, not the behavior under test.
async function landVersion(page: Page, id: string, body: string): Promise<void> {
  await expect(async () => {
    const res = await page.request.post(`/v1/artifacts/${id}/versions`, {
      multipart: { file: { name: "doc.md", mimeType: "text/markdown", buffer: Buffer.from(body) } },
    })
    expect(res.ok(), `landVersion failed: ${res.status()}`).toBeTruthy()
  }).toPass({ timeout: 10_000 })
}

// Open the in-flow source editor — this is where editBase (the version we publish
// against) is captured, so anything that lands afterward is a concurrent edit.
async function openEditor(page: Page): Promise<void> {
  await page.getByTestId("artifact-more").click()
  await page.getByTestId("artifact-edit").click()
  await expect(page.getByTestId("artifact-source-editor")).toBeVisible()
}

// Replace the whole (small) doc in the CodeMirror editor.
async function setSource(page: Page, text: string): Promise<void> {
  const cm = page.locator(".cm-content")
  await cm.click()
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.press("Delete")
  await page.keyboard.type(text)
}

async function readSource(page: Page, id: string): Promise<string> {
  const res = await page.request.get(`/v1/artifacts/${id}/content`)
  expect(res.ok()).toBeTruthy()
  return res.text()
}

test("a disjoint concurrent edit merges silently on publish (no conflict UI)", async ({
  owner,
}) => {
  const id = await publishArtifact(owner, "doc.md", BASE) // v1
  await owner.goto(`/a/${id}`)
  await openEditor(owner) // editBase = 1

  await landVersion(owner, id, "alpha ONE\n\nbeta\n\ngamma\n") // teammate edits para 1
  await setSource(owner, "alpha\n\nbeta\n\ngamma TWO\n") // we edit para 3
  await owner.getByTestId("artifact-publish-version").click()

  // Clean path: no conflict UI ever appears and the editor closes on success.
  await expect(owner.getByTestId("conflict-card")).toHaveCount(0)
  await expect(owner.getByTestId("artifact-source-editor")).toBeHidden()

  // No clobber: the merged doc carries BOTH the teammate's para 1 and our para 3.
  await expect(async () => {
    const src = await readSource(owner, id)
    expect(src).toContain("alpha ONE")
    expect(src).toContain("gamma TWO")
  }).toPass({ timeout: 10_000 })
})

test("an overlapping edit opens the resolver; Use mine keeps our edit and goes live", async ({
  owner,
}) => {
  const id = await publishArtifact(owner, "doc.md", BASE)
  await owner.goto(`/a/${id}`)
  await openEditor(owner)

  await landVersion(owner, id, "alpha ONE\n\nbeta\n\ngamma\n")
  await setSource(owner, "alpha TWO\n\nbeta\n\ngamma\n")
  await owner.getByTestId("artifact-publish-version").click()

  const card = owner.getByTestId("conflict-card")
  await expect(card).toHaveCount(1)
  await expect(card.getByText("alpha ONE")).toBeVisible() // current
  await expect(card.getByText("alpha TWO")).toBeVisible() // ours

  await owner.getByTestId("conflict-use-mine").click()
  await owner.getByTestId("conflict-publish").click()

  await expect(owner.getByTestId("conflict-card")).toHaveCount(0)
  await expect(owner.getByTestId("artifact-source-editor")).toBeHidden()
  await expect(async () => {
    expect(await readSource(owner, id)).toContain("alpha TWO")
  }).toPass({ timeout: 10_000 })
})

test("Use current discards the clashing edit while a disjoint edit still lands", async ({
  owner,
}) => {
  const id = await publishArtifact(owner, "doc.md", BASE)
  await owner.goto(`/a/${id}`)
  await openEditor(owner)

  await landVersion(owner, id, "alpha ONE\n\nbeta\n\ngamma\n") // teammate: para 1
  await setSource(owner, "alpha TWO\n\nbeta\n\ngamma MINE\n") // us: para 1 (clash) + para 3 (disjoint)
  await owner.getByTestId("artifact-publish-version").click()

  // Only para 1 conflicts; para 3 auto-merged into the clean surround.
  await expect(owner.getByTestId("conflict-card")).toHaveCount(1)
  await owner.getByTestId("conflict-use-current").click()
  await owner.getByTestId("conflict-publish").click()

  await expect(owner.getByTestId("conflict-card")).toHaveCount(0)
  await expect(async () => {
    const src = await readSource(owner, id)
    expect(src).toContain("alpha ONE") // current won the clash
    expect(src).not.toContain("alpha TWO") // our clashing edit was discarded
    expect(src).toContain("gamma MINE") // our disjoint edit still landed
  }).toPass({ timeout: 10_000 })
})

test("Edit writes a hand-merged reconciliation verbatim", async ({ owner }) => {
  const id = await publishArtifact(owner, "doc.md", BASE)
  await owner.goto(`/a/${id}`)
  await openEditor(owner)

  await landVersion(owner, id, "alpha ONE\n\nbeta\n\ngamma\n")
  await setSource(owner, "alpha TWO\n\nbeta\n\ngamma\n")
  await owner.getByTestId("artifact-publish-version").click()

  await expect(owner.getByTestId("conflict-card")).toHaveCount(1)
  await owner.getByTestId("conflict-edit").click()
  await owner.getByTestId("conflict-edit-text").fill("alpha BOTH ONE AND TWO\n")
  await owner.getByTestId("conflict-publish").click()

  await expect(owner.getByTestId("conflict-card")).toHaveCount(0)
  await expect(async () => {
    const src = await readSource(owner, id)
    expect(src).toContain("alpha BOTH ONE AND TWO")
    expect(src).not.toContain("alpha ONE")
    expect(src).not.toContain("alpha TWO")
  }).toPass({ timeout: 10_000 })
})

test("two independent conflicts resolve separately in one publish", async ({ owner }) => {
  const id = await publishArtifact(owner, "doc.md", BASE)
  await owner.goto(`/a/${id}`)
  await openEditor(owner)

  await landVersion(owner, id, "alpha ONE\n\nbeta\n\ngamma ONE\n") // teammate: para 1 + para 3
  await setSource(owner, "alpha TWO\n\nbeta\n\ngamma TWO\n") // us: para 1 + para 3, differently
  await owner.getByTestId("artifact-publish-version").click()

  const cards = owner.getByTestId("conflict-card")
  await expect(cards).toHaveCount(2)
  // The publish button is gated until every conflict is resolved.
  await expect(owner.getByTestId("conflict-publish")).toBeDisabled()

  await cards.nth(0).getByTestId("conflict-use-mine").click() // para 1 → ours
  await cards.nth(1).getByTestId("conflict-use-current").click() // para 3 → theirs
  await expect(owner.getByTestId("conflict-publish")).toBeEnabled()
  await owner.getByTestId("conflict-publish").click()

  await expect(owner.getByTestId("conflict-card")).toHaveCount(0)
  await expect(async () => {
    const src = await readSource(owner, id)
    expect(src).toContain("alpha TWO") // para 1: our edit
    expect(src).toContain("gamma ONE") // para 3: theirs
    expect(src).not.toContain("alpha ONE")
    expect(src).not.toContain("gamma TWO")
  }).toPass({ timeout: 10_000 })
})

test("a publish that lands mid-resolve re-opens the resolver with fresh hunks", async ({
  owner,
}) => {
  const id = await publishArtifact(owner, "doc.md", BASE)
  await owner.goto(`/a/${id}`)
  await openEditor(owner) // editBase = 1

  await landVersion(owner, id, "alpha ONE\n\nbeta\n\ngamma\n") // v2: para 1
  await setSource(owner, "alpha TWO\n\nbeta\n\ngamma\n")
  await owner.getByTestId("artifact-publish-version").click()

  const card = owner.getByTestId("conflict-card")
  await expect(card).toHaveCount(1)
  await expect(card.getByText("alpha ONE")).toBeVisible()

  // Someone publishes the same paragraph AGAIN before we finish resolving.
  await landVersion(owner, id, "alpha THREE\n\nbeta\n\ngamma\n") // v3

  await owner.getByTestId("conflict-use-mine").click()
  await owner.getByTestId("conflict-publish").click()

  // Republish raced the new v3, so a fresh conflict opens showing the newer text.
  await expect(card.getByText("alpha THREE")).toBeVisible()
  await owner.getByTestId("conflict-use-mine").click()
  await owner.getByTestId("conflict-publish").click()

  await expect(owner.getByTestId("conflict-card")).toHaveCount(0)
  await expect(async () => {
    expect(await readSource(owner, id)).toContain("alpha TWO")
  }).toPass({ timeout: 10_000 })
})
