import type { Page } from "@playwright/test"
import { expect, openArtifact, publishArtifact, shareArtifact, test } from "./fixtures"

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
const RESIZE_DOC = `<h1>Layout</h1>
<img id="hero" alt="Hero" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='90'%3E%3Crect width='160' height='90' fill='%2364748b'/%3E%3C/svg%3E" style="display:block;width:160px;height:90px">
<div id="summary-box" data-derive-resizable style="width:220px;height:110px"><p>Summary box.</p></div>`
const HIERARCHY_DOC = `<!doctype html><html><head><style>
body{font-family:sans-serif}.root{display:flex;flex-direction:column;gap:12px}.board{padding:16px;border:2px solid #334155}.cards{display:flex;gap:10px}.card{width:120px;padding:12px;border:1px solid #94a3b8}
[data-derive-region][data-derive-layout="stack"]>[data-derive-node][data-derive-size="compact"]{width:50%!important;max-width:none!important;box-sizing:border-box!important}
[data-derive-region][data-derive-layout="stack"]>[data-derive-node][data-derive-size="standard"]{width:75%!important;max-width:none!important;box-sizing:border-box!important}
[data-derive-region][data-derive-layout="stack"]>[data-derive-node][data-derive-size="full"]{width:100%!important;max-width:none!important;box-sizing:border-box!important}
</style></head><body>
<main class="root" data-derive-region="page" data-derive-layout="stack">
  <h1 id="title" data-derive-node="title">Hierarchy</h1>
  <section id="board" class="board" data-derive-node="board" data-derive-kind="group">
    <h2>Three cards</h2>
    <div id="cards" class="cards" data-derive-region="board-cards" data-derive-layout="stack" data-derive-owner="board">
      <article id="card-a" class="card" data-derive-node="discover">Discover</article>
      <article id="card-b" class="card" data-derive-node="move">Move</article>
      <article id="card-c" class="card" data-derive-node="recover">Recover</article>
    </div>
  </section>
  <p id="footer" data-derive-node="footer">Recovery stays available.</p>
</main></body></html>`

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
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("click text to edit")
  await expect(doc(owner).locator("#one")).toHaveText("First paragraph.")
  await expect(owner.getByTestId("inline-edit-undo")).toBeDisabled()
  await expect(owner.getByTestId("inline-edit-redo")).toBeDisabled()

  // A second cycle gets a fresh history rather than reviving the abandoned first one.
  await appendToParagraph(owner, "two", " Throwaway too.")
  await owner.getByTestId("inline-edit-discard").click()
  await expect(doc(owner).locator("#two")).toHaveText("Second paragraph.")
  await expect(owner.getByTestId("inline-edit-undo")).toBeDisabled()
  await expect(owner.getByTestId("inline-edit-redo")).toBeDisabled()
  expect(await versionOf(owner, shortId)).toBe(1)
})

test("a resolved collaborator becomes a portable chip; code and unknown handles stay plain", async ({
  owner,
  secondUser,
}) => {
  const shortId = await publishArtifact(
    owner,
    "mentions.html",
    '<p id="one">Ask the team.</p><pre>@example-code</pre><p id="ambient">Follow @not-a-real-user</p>',
    "text/html",
  )
  await openArtifact(owner, shortId)
  // Syntax alone must not impersonate a directed Derive mention in the reader.
  await expect(doc(owner).locator("[data-derive-mention]")).toHaveCount(0)

  await shareArtifact(owner.request, shortId, secondUser.email, "viewer")
  const directory = await owner.request.get(`/v1/users?artifact=${shortId}&query=second`)
  expect(directory.ok()).toBeTruthy()
  const users = (await directory.json()) as {
    users: { handle: string | null; name: string | null }[]
  }
  const handle = users.users.find((user) => user.name === "Second User")?.handle
  expect(handle).toBeTruthy()
  if (!handle) throw new Error("shared collaborator missing from mention directory")

  await enterEditMode(owner)
  await doc(owner).locator("#one").click()
  await owner.keyboard.press("End")
  await owner.keyboard.type(` @${handle}`)
  await expect(owner.getByTestId("inline-mention-menu")).toBeVisible()
  await expect(owner.getByTestId("inline-mention-option")).toHaveCount(1)
  await owner.keyboard.press("Enter")
  await expect(doc(owner).locator("[data-derive-mention]")).toHaveText(`@${handle}`)

  await owner.getByTestId("inline-edit-save").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()
  await expect(async () => {
    const stored = await contentOf(owner, shortId)
    expect(stored).toContain(`@${handle}`)
    expect(stored).not.toContain("derive-mention")
  }).toPass({ timeout: 10_000 })
  // The newly loaded reader resolves the persisted handle again; the chip survives
  // without storing framework markup in the document.
  await expect(doc(owner).locator("[data-derive-mention]")).toHaveText(`@${handle}`)
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

test("double-clicking the text stays a plain word select — it never opens the mode", async ({
  owner,
}) => {
  // The gesture used to be an entry point; it was removed because it collided with
  // the reading grammar (select a word to comment/quote it). The button, `e`, and
  // Edit on a selection are the ways in. This pins the removal.
  await seed(owner)
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()

  await doc(owner).locator("#two").dblclick()
  // Give a would-be edit-request round trip time to land before reading the bar.
  await owner.waitForTimeout(500)
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()
})

test("`e` opens the mode from the keyboard", async ({ owner }) => {
  await seed(owner)
  // The shortcut stays silent until the record says this viewer may edit, so wait
  // for the affordance that proves it rather than racing the query.
  await expect(owner.getByTestId("artifact-inline-edit")).toBeVisible()
  await owner.keyboard.press("e")
  await expect(owner.getByTestId("inline-edit-bar")).toBeVisible()
  // …and Escape closes it again (nothing typed, so no confirm).
  await owner.keyboard.press("Escape")
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()
})

test("renaming is metadata — the title changes and the history does not", async ({ owner }) => {
  const shortId = await publishArtifact(owner, "named.html", DOC, "text/html")
  await openArtifact(owner, shortId)

  await owner.getByTestId("artifact-title").dblclick()
  const field = owner.getByTestId("artifact-title-rename")
  await expect(field).toBeVisible()
  await field.fill("A better name")
  await field.press("Enter")

  await expect(owner.getByTestId("artifact-title")).toHaveText("A better name")
  // The rename must not mint a version: that was the whole point of the endpoint.
  expect(await versionOf(owner, shortId)).toBe(1)
})

test("the bar's controls: undo, redo, and a format that reaches the source", async ({ owner }) => {
  const shortId = await seed(owner)
  await enterEditMode(owner)

  // Nothing done, nothing selected: every control is honest about having nothing to do.
  await expect(owner.getByTestId("inline-edit-undo")).toBeDisabled()
  await expect(owner.getByTestId("inline-edit-redo")).toBeDisabled()
  await expect(owner.getByTestId("inline-edit-undo")).toContainText("Undo")
  await expect(owner.getByTestId("inline-edit-redo")).toContainText("Redo")
  await expect(owner.getByTestId("inline-edit-bold")).toBeDisabled()
  await expect(owner.getByTestId("artifact-inspect-choose")).toBeVisible()

  await appendToParagraph(owner, "one", " Typed.")
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("1 unsaved change")
  await expect(owner.getByTestId("inline-edit-undo")).toBeEnabled()
  await expect(owner.getByTestId("artifact-inspect-text")).toContainText("Paragraph")
  await expect(owner.getByTestId("artifact-inspect-undo")).toBeEnabled()
  await expect(owner.getByTestId("artifact-inspect-undo")).toContainText("Undo")
  await expect(owner.getByTestId("artifact-inspect-redo")).toContainText("Redo")

  // Inspect and the bar drive one history stack. Undo in the rail takes the document
  // back; redo in the bar returns both the text and the rail's live state.
  await owner.getByTestId("artifact-inspect-undo").click()
  await expect(doc(owner).locator("#one")).toHaveText("First paragraph.")
  await expect(owner.getByTestId("inline-edit-bar")).not.toContainText("unsaved change")
  await owner.getByTestId("inline-edit-redo").click()
  await expect(doc(owner).locator("#one")).toHaveText("First paragraph. Typed.")

  // A selection appears in the contextual rail, lights both formatting surfaces,
  // and Bold from Inspect reaches the stored source as <b>.
  await doc(owner).locator("#two").dblclick()
  await expect(owner.getByTestId("inline-edit-bold")).toBeEnabled()
  await expect(owner.getByTestId("artifact-inspect-bold")).toBeEnabled()
  await expect(owner.getByTestId("artifact-inspect-text")).toContainText(/“[^”]+”/)
  await owner.getByTestId("artifact-inspect-bold").click()
  await expect(owner.getByTestId("artifact-inspect-bold")).toBeDisabled()
  await owner.getByTestId("inline-edit-save").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()

  const src = await contentOf(owner, shortId)
  expect(src).toContain("First paragraph. Typed.")
  // A <b> inside that paragraph — wherever the double-click's word selection landed —
  // and the paragraph's TEXT untouched: formatting adds markup, never words.
  expect(src).toMatch(/<p id=two>[\s\S]*<b>[^<]+<\/b>[\s\S]*<\/p>/)
  expect(src.replace(/<\/?b>/g, "")).toContain("<p id=two>Second paragraph.</p>")
  // The editor's own markers never reach the document.
  expect(src).not.toContain("data-derive-fmt")
})

test("the edit bar keeps history and terminal actions reachable at phone width", async ({
  owner,
}) => {
  await seed(owner)
  await enterEditMode(owner)
  await owner.setViewportSize({ width: 320, height: 720 })

  const bar = owner.getByTestId("inline-edit-bar")
  await expect(owner.getByTestId("inline-edit-undo").getByText("Undo")).toBeVisible()
  await expect(owner.getByTestId("inline-edit-redo").getByText("Redo")).toBeVisible()
  await expect(owner.getByTestId("inline-edit-done")).toBeInViewport({ ratio: 1 })
  expect(await bar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)

  await appendToParagraph(owner, "one", " Phone.")
  await expect(owner.getByTestId("inline-edit-discard")).toBeInViewport({ ratio: 1 })
  await expect(owner.getByTestId("inline-edit-save")).toBeInViewport({ ratio: 1 })
  expect(await bar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
})

test("Inspect preserves a text selection while asking for a link", async ({ owner }) => {
  const shortId = await seed(owner)
  await enterEditMode(owner)

  // Link is the one formatting verb with an intermediate question in the host.
  // The frame must preserve a selected word while the rail's URL field owns focus.
  await doc(owner).locator("#one").click()
  await expect(owner.getByTestId("artifact-inspect-text")).toContainText("Paragraph")
  await owner.keyboard.press("Home")
  await owner.keyboard.down("Shift")
  for (let i = 0; i < 5; i++) await owner.keyboard.press("ArrowRight")
  await owner.keyboard.up("Shift")
  await expect(owner.getByTestId("artifact-inspect-link")).toBeEnabled()
  await owner.getByTestId("artifact-inspect-link").click()
  await owner.getByTestId("artifact-inspect-link-input").fill("https://derive.to")
  await owner.getByTestId("artifact-inspect-link-input").press("Enter")
  await expect(owner.getByTestId("artifact-inspect-status")).toContainText("1 unsaved change")
  await owner.getByTestId("artifact-inspect-save").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()

  const src = await contentOf(owner, shortId)
  expect(src).toMatch(/<p id=one>[\s\S]*<a href="https:\/\/derive\.to">[^<]+<\/a>[\s\S]*<\/p>/)
})

test("resize an image and box, then undo/redo and save", async ({ owner }) => {
  const shortId = await publishArtifact(owner, "layout.html", RESIZE_DOC, "text/html")
  await openArtifact(owner, shortId)
  await enterEditMode(owner)

  const image = doc(owner).locator("#hero")
  await image.hover()
  const handle = doc(owner).getByRole("button", { name: "Resize element" })
  await expect(handle).toBeVisible()
  const grip = await handle.boundingBox()
  expect(grip).not.toBeNull()
  if (!grip) return

  await owner.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await owner.mouse.down()
  await owner.mouse.move(grip.x + grip.width / 2 + 40, grip.y + grip.height / 2 + 20)
  await owner.mouse.up()

  await expect(owner.getByTestId("inline-edit-bar")).toContainText("1 unsaved change")
  await expect(image).toHaveCSS("width", "200px")
  // Images keep their natural ratio instead of stretching to follow the pointer.
  expect(await image.evaluate((el) => el.style.height)).toBe("auto")

  await owner.getByTestId("inline-edit-undo").click()
  await expect(image).toHaveCSS("width", "160px")
  await expect(owner.getByTestId("inline-edit-bar")).not.toContainText("unsaved change")
  await owner.getByTestId("inline-edit-redo").click()
  await expect(image).toHaveCSS("width", "200px")

  const box = doc(owner).locator("#summary-box")
  // Select the box's padding rather than activating the editable paragraph inside it.
  await box.click({ position: { x: 210, y: 100 } })
  const boxHandle = doc(owner).getByRole("button", { name: "Resize element" })
  await boxHandle.focus()
  await boxHandle.press("ArrowRight")
  await boxHandle.press("ArrowDown")
  await expect(box).toHaveCSS("width", "228px")
  await expect(box).toHaveCSS("height", "118px")
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("2 unsaved changes")

  await owner.getByTestId("inline-edit-save").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()
  const src = await contentOf(owner, shortId)
  expect(src).toContain("display:block; width: 200px; height: auto")
  expect(src).toContain(
    '<div id="summary-box" data-derive-resizable style="width: 228px; height: 118px">',
  )
})

test("nested cards and their owning group move independently, undo, and save safely", async ({
  owner,
}) => {
  const shortId = await publishArtifact(owner, "hierarchy.html", HIERARCHY_DOC, "text/html")
  await openArtifact(owner, shortId)
  await enterEditMode(owner)

  const frame = doc(owner)
  const cards = frame.locator("#cards > [data-derive-node]")
  await frame.locator("#card-a").click()
  const parent = frame.getByRole("button", { name: "Select containing group (Escape)" })
  await expect(parent).toBeVisible()
  await frame.getByRole("button", { name: "Drag to reorder" }).dragTo(frame.locator("#card-b"))
  await expect(cards.nth(0)).toHaveAttribute("id", "card-b")
  await expect(cards.nth(1)).toHaveAttribute("id", "card-a")

  // The explicit level control selects the board itself; its next move operates in
  // the page region and carries the already-reordered child region along unchanged.
  await parent.click()
  await expect(parent).toBeHidden()
  await frame.getByRole("button", { name: "Move earlier (Option+Up)" }).click()
  expect(
    await frame.locator("#board").evaluate((el) => el.parentElement?.firstElementChild === el),
  ).toBe(true)

  // Removing a parent temporarily disconnects its child region. That is expected,
  // not corruption: one shared Undo restores the complete live subtree and both
  // region-local moves remain representable.
  await frame.getByRole("button", { name: "Remove element (Delete)" }).click()
  await expect(frame.locator("#board")).toHaveCount(0)
  await owner.getByTestId("inline-edit-undo").click()
  await expect(frame.locator("#board")).toHaveCount(1)
  await expect(cards.nth(0)).toHaveAttribute("id", "card-b")

  await owner.getByTestId("inline-edit-save").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()
  const saved = await contentOf(owner, shortId)
  expect(saved.indexOf('data-derive-node="board"')).toBeLessThan(
    saved.indexOf('data-derive-node="title"'),
  )
  expect(saved.indexOf('data-derive-node="move"')).toBeLessThan(
    saved.indexOf('data-derive-node="discover"'),
  )
  expect(saved).toContain('data-derive-owner="board"')

  // Discard walks both levels back to the just-saved hierarchy without publishing.
  await enterEditMode(owner)
  await frame.locator("#card-b").click()
  await frame.getByRole("button", { name: "Move later (Option+Down)" }).click()
  await expect(cards.nth(0)).toHaveAttribute("id", "card-a")
  await owner.getByTestId("inline-edit-discard").click()
  await expect(cards.nth(0)).toHaveAttribute("id", "card-b")

  // If the final intent removes the parent, child-region changes are superseded by
  // that atomic subtree removal instead of producing a dangling operation.
  await enterEditMode(owner)
  await frame.locator("#card-b").click()
  await frame.getByRole("button", { name: "Move later (Option+Down)" }).click()
  await frame.getByRole("button", { name: "Select containing group (Escape)" }).click()
  await frame.getByRole("button", { name: "Remove element (Delete)" }).click()
  await owner.getByTestId("inline-edit-save").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()
  expect(await contentOf(owner, shortId)).not.toContain('data-derive-node="board"')
})

test("set exact dimensions, constrain a box, and reset to the authored size", async ({ owner }) => {
  const shortId = await publishArtifact(owner, "precision.html", RESIZE_DOC, "text/html")
  await openArtifact(owner, shortId)
  await enterEditMode(owner)

  const image = doc(owner).locator("#hero")
  await image.hover()
  const size = doc(owner).getByRole("button", { name: "Set element size" })
  await expect(size).toHaveText("160 × 90")
  await size.click()
  const panel = doc(owner).getByRole("form", { name: "Element size" })
  const width = panel.getByLabel("Width in pixels")
  const height = panel.getByLabel("Height in pixels")
  const lock = panel.getByRole("checkbox", { name: "Proportions locked" })
  await expect(panel).toBeVisible()
  await expect(width).toHaveValue("160")
  await expect(height).toHaveValue("90")
  await expect(lock).toBeChecked()
  await expect(lock).toBeDisabled()

  // Escape dismisses the small editor, not the entire inline-edit session.
  await owner.keyboard.press("Escape")
  await expect(panel).toBeHidden()
  await expect(owner.getByTestId("inline-edit-bar")).toBeVisible()
  await expect(size).toBeFocused()

  await size.click()
  await panel.getByLabel("Width in pixels").fill("320")
  await expect(panel.getByLabel("Height in pixels")).toHaveValue("180")
  await panel.getByRole("button", { name: "Apply" }).click()
  await expect(image).toHaveCSS("width", "320px")
  await expect(image).toHaveCSS("height", "180px")
  expect(await image.evaluate((el) => el.style.height)).toBe("auto")
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("1 unsaved change")

  await size.click()
  await panel.getByRole("button", { name: "Reset to authored size" }).click()
  await expect(image).toHaveCSS("width", "160px")
  await expect(image).toHaveCSS("height", "90px")
  await expect(owner.getByTestId("inline-edit-bar")).not.toContainText("unsaved change")

  const box = doc(owner).locator("#summary-box")
  await box.click({ position: { x: 210, y: 100 } })
  await size.click()
  await expect(panel.getByRole("checkbox", { name: "Lock proportions" })).not.toBeChecked()
  await panel.getByLabel("Width in pixels").fill("280")
  await panel.getByLabel("Height in pixels").fill("150")
  await panel.getByRole("button", { name: "Apply" }).click()
  await expect(box).toHaveCSS("width", "280px")
  await expect(box).toHaveCSS("height", "150px")

  await size.click()
  const boxLock = panel.getByRole("checkbox", { name: "Lock proportions" })
  await boxLock.check()
  await panel.getByLabel("Width in pixels").fill("308")
  await expect(panel.getByLabel("Height in pixels")).toHaveValue("165")
  // The editor's global save chord commits a still-open precision form first, so
  // values typed here cannot disappear when Save closes the session.
  await panel.getByLabel("Width in pixels").press("Control+s")
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()
  const src = await contentOf(owner, shortId)
  expect(src).toContain(
    '<div id="summary-box" data-derive-resizable style="width: 308px; height: 165px">',
  )
  // Reset removed the temporary image edit rather than publishing a redundant size.
  expect(src).toContain('style="display:block;width:160px;height:90px"')
})

test("keyboard users can discover resize controls and open exact sizing", async ({ owner }) => {
  const shortId = await publishArtifact(owner, "keyboard-resize.html", RESIZE_DOC, "text/html")
  await openArtifact(owner, shortId)
  await enterEditMode(owner)

  const image = doc(owner).locator("#hero")
  // Done is the last control in the edit bar. The next Tab enters the artifact and
  // lands on the first supported resizable element instead of skipping the frame.
  await owner.getByTestId("inline-edit-done").focus()
  await owner.keyboard.press("Tab")
  await expect(image).toBeFocused()
  await expect(doc(owner).getByRole("button", { name: "Resize element" })).toBeVisible()

  await owner.keyboard.press("Enter")
  const panel = doc(owner).getByRole("form", { name: "Element size" })
  await expect(panel).toBeVisible()
  await expect(panel.getByLabel("Width in pixels")).toBeFocused()
  await expect(panel.getByLabel("Width in pixels")).toHaveValue("160")

  await owner.keyboard.press("Escape")
  await owner.getByTestId("inline-edit-done").click()
  await expect(image).not.toHaveAttribute("tabindex")
})

test("Markdown keeps image replacement without offering an unsaveable resize", async ({
  owner,
}) => {
  const markdown = "# Layout\n\n![Hero](/brand/favicon.svg)"
  const shortId = await publishArtifact(owner, "layout.md", markdown, "text/markdown")
  await openArtifact(owner, shortId)
  await enterEditMode(owner)
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("select an image to replace it")
  await expect(owner.getByTestId("inline-edit-bar")).not.toContainText("resize")

  await doc(owner).getByRole("img", { name: "Hero" }).hover()
  // The existing image-swap flow works for Markdown because it replaces the literal
  // URL. Resize is different: it needs an HTML opening tag, so promising it here
  // would make Save fail after the user had already done the work.
  await expect(doc(owner).getByRole("button", { name: "Replace image" })).toBeVisible()
  await expect(doc(owner).getByRole("button", { name: "Resize element" })).toBeHidden()
})

test("Markdown saves a selection across consecutive bold subtitle lines", async ({ owner }) => {
  const markdown =
    "# Chief of Staff\n\n" +
    "**San Francisco · Full-time · In person**  \n" +
    "**$150,000–$180,000 base + discretionary bonus + carry eligibility**\n\n" +
    "## The opportunity\n"
  const shortId = await publishArtifact(owner, "role.md", markdown, "text/markdown")
  await openArtifact(owner, shortId)
  await enterEditMode(owner)

  const subtitle = doc(owner).locator("p").first()
  await subtitle.click()
  await subtitle.evaluate((el) => {
    const runs = el.querySelectorAll("strong")
    const first = runs[0]?.firstChild
    const second = runs[1]?.firstChild
    if (!first || !second) throw new Error("subtitle strong runs missing")
    const range = document.createRange()
    range.setStart(first, first.textContent?.lastIndexOf("person") ?? 0)
    range.setEnd(second, second.textContent?.length ?? 0)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await owner.keyboard.type("person")
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("1 unsaved change")
  await owner.getByTestId("inline-edit-save").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()

  await expect(async () => {
    const stored = await contentOf(owner, shortId)
    expect(stored).toContain("**San Francisco · Full-time · In person**")
    expect(stored).not.toContain("$150,000")
  }).toPass({ timeout: 10_000 })
})

test("typing across attributed inline elements refuses instead of flattening authored metadata", async ({
  owner,
}) => {
  const html =
    '<p class="target"><a href="/jobs">ORBIT-LINK</a> <mark data-note="keep">ORBIT-NOTE</mark></p>'
  const shortId = await publishArtifact(owner, "protected-inline.html", html, "text/html")
  await openArtifact(owner, shortId)
  await enterEditMode(owner)

  const target = doc(owner).locator("p.target")
  // The preview timeout overlay can race a healthy iframe in the local harness;
  // the frame is already rendered and interactive, so exercise the frame directly.
  await target.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    el.querySelector("a")?.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 8,
        clientY: rect.top + rect.height / 2,
        detail: 1,
      }),
    )
  })
  await expect(target).toHaveAttribute("contenteditable", /^(plaintext-only|true)$/)
  await target.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await owner.keyboard.type("REFUSAL-CHECK")

  await expect(
    owner.getByText("That selection includes linked or annotated content."),
  ).toBeVisible()
  await expect(target).toContainText("ORBIT-LINK ORBIT-NOTE")
  await expect(target.locator('a[href="/jobs"]')).toHaveText("ORBIT-LINK")
  await expect(target.locator('mark[data-note="keep"]')).toHaveText("ORBIT-NOTE")
  await expect(owner.getByTestId("inline-edit-save")).toHaveCount(0)
  expect(await contentOf(owner, shortId)).toBe(html)
})

test("Inspect appears only inside an editor's HTML edit session", async ({ owner, secondUser }) => {
  // Make the shared chat tab explicit for this isolated workspace. The resting artifact
  // is conversation-only; Inspect appears only after the existing Edit entry point.
  const settings = await owner.request.patch("/v1/workspace/settings", {
    data: { chatBeta: true },
  })
  expect(settings.ok(), `settings patch failed: ${settings.status()}`).toBeTruthy()

  const shortId = await publishArtifact(owner, "rail.html", RESIZE_DOC, "text/html")
  await openArtifact(owner, shortId)

  const tabs = owner.getByTestId("rail-tabs").getByRole("button")
  await expect(tabs).toHaveCount(2)
  await expect(tabs).toHaveText(["Activity", "Chat"])
  await expect(owner.getByTestId("rail-tab-comments")).toHaveAttribute("aria-pressed", "true")
  await expect(owner.getByTestId("rail-tab-inspect")).toHaveCount(0)

  await owner.getByTestId("rail-tab-chat").click()
  await expect(owner.getByTestId("artifact-chat")).toBeVisible()

  await owner.getByTestId("artifact-inline-edit").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeVisible()
  await expect(tabs).toHaveText(["Activity", "Chat", "Inspect"])
  await expect(owner.getByTestId("rail-tab-inspect")).toHaveAttribute("aria-pressed", "true")
  await expect(owner.getByTestId("artifact-inspect-choose")).toContainText(
    "Choose content in the document",
  )
  await expect(owner.getByTestId("artifact-inspect-status")).toHaveText("No unsaved changes")
  await owner.getByTestId("artifact-inspect-done").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()
  await expect(owner.getByTestId("rail-tab-inspect")).toHaveCount(0)

  // A commenter can still participate in the primary conversation, but never gains a
  // visual source-editing tab. The API keeps enforcing the same boundary underneath it.
  await shareArtifact(owner.request, shortId, secondUser.email, "commenter")
  await openArtifact(secondUser.page, shortId)
  await expect(secondUser.page.getByTestId("rail-tab-inspect")).toHaveCount(0)

  // Markdown is the lightweight, direct-text path. It keeps Comments and Chat but never
  // promises an element operation that cannot be represented in Markdown source.
  const markdownId = await publishArtifact(owner, "rail.md", "# A markdown doc", "text/markdown")
  await openArtifact(owner, markdownId)
  await expect(owner.getByTestId("rail-tabs").getByRole("button")).toHaveText(["Activity", "Chat"])
  await expect(owner.getByTestId("rail-tab-inspect")).toHaveCount(0)
})

test("a newly published HTML artifact enters Inspect without a reload", async ({ owner }) => {
  // Publishing seeds the detail cache for an immediate navigation. That seed has to
  // retain the just-published owner's role: otherwise Edit disappears until the detail
  // query is manually refreshed, and the author cannot enter Inspect from it.
  await owner.goto("/new")
  await owner.getByTestId("artifact-title-input").fill("Fresh HTML artifact")
  await expect(owner.locator(".cm-content")).toBeVisible()
  // This scenario covers the post-publish cache handoff, not CodeMirror's keystroke
  // dispatch. Fill avoids incidental global shortcut events from URL-like HTML source.
  await owner.locator(".cm-content").fill(RESIZE_DOC)
  await expect(owner.getByTestId("artifact-publish-version")).toBeEnabled()
  await owner.getByTestId("artifact-publish-version").click()

  await expect(owner).toHaveURL(/\/artifacts\//)
  await expect(owner.getByTestId("artifact-inline-edit")).toBeVisible()
  await expect(owner.getByTestId("rail-tab-inspect")).toHaveCount(0)
  await owner.getByTestId("artifact-inline-edit").click()
  await expect(owner.getByTestId("rail-tab-inspect")).toBeVisible()
})
