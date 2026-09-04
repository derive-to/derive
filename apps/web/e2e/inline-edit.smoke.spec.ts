import type { Page } from "@playwright/test"
import { zipSync } from "fflate"
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

const STRUCTURAL_RESIZE_DOC = `<style>
.stage { width: 720px; transform: scale(.75); transform-origin: top left }
.stack { width: 600px; padding: 20px; display: flex; flex-direction: column; gap: 16px }
.stack > [data-derive-node] { min-height: 80px; padding: 16px; border: 1px solid #ccd; box-sizing: border-box }
.stack > [data-derive-node][data-derive-size="compact"] { width: 50%; max-width: none }
.stack > [data-derive-node][data-derive-size="standard"] { width: 75%; max-width: none }
.stack > [data-derive-node][data-derive-size="full"] { width: 100%; max-width: none }
.stack > [data-derive-node][data-derive-width] { width: var(--derive-structural-width); max-width: none }
.stack > [data-derive-node][data-derive-height] { height: var(--derive-structural-height); box-sizing: border-box }
.stack > [data-derive-node][data-derive-align] { align-self: var(--derive-structural-align) }
</style>
<div class="stage">
  <section class="stack" data-derive-ready data-derive-region="story" data-derive-layout="stack">
    <article id="alpha" data-derive-node="alpha" data-derive-kind="card" data-derive-size="compact" style="transition: width 2s ease, height 2s ease; color: navy">Alpha</article>
    <article id="bravo" data-derive-node="bravo" data-derive-kind="card" data-derive-width="68" style="--derive-structural-width: 68%; height: 128px">Bravo</article>
  </section>
</div>`

const STRUCTURAL_MULTISELECT_DOC = `<style>
body { font-family: sans-serif }
@media (max-width: 420px) { body { --dogfood-breakpoint: mobile } }
.stack { width: 600px; padding: 12px; display: flex; flex-direction: column; gap: 12px }
.stack > [data-derive-node] { min-height: 48px; padding: 10px; border: 1px solid #ccd; box-sizing: border-box }
.stack > [data-derive-node][data-derive-width] { width: var(--derive-structural-width); max-width: none }
.stack > [data-derive-node][data-derive-height] { height: var(--derive-structural-height); box-sizing: border-box }
.stack > [data-derive-node][data-derive-align] { align-self: var(--derive-structural-align) }
#delta { min-height: 140px }
</style>
<section id="multi" class="stack" data-derive-ready data-derive-region="multi" data-derive-layout="stack">
  <article id="alpha" data-derive-node="alpha" data-derive-width="52" data-derive-height="96" style="--derive-structural-width: 52%; --derive-structural-height: 96px">Alpha</article>
  <article id="bravo" data-derive-node="bravo" data-derive-width="68" data-derive-height="112" style="--derive-structural-width: 68%; --derive-structural-height: 112px">Bravo</article>
  <article id="charlie" data-derive-node="charlie" data-derive-width="76" style="--derive-structural-width: 76%">Charlie</article>
  <article id="delta" data-derive-node="delta" data-derive-width="84" style="--derive-structural-width: 84%">Delta cannot safely shrink to Alpha height.</article>
</section>
<section class="stack" data-derive-region="other" data-derive-layout="stack">
  <article id="echo" data-derive-node="echo">Echo</article>
</section>`

const STRUCTURAL_DISTRIBUTE_DOC = `<style>
body { font-family: sans-serif }
.stack { width: 560px; height: 500px; padding: 12px; display: flex; flex-direction: column; gap: 12px; box-sizing: border-box }
.stack[data-derive-gap] { gap: var(--derive-structural-gap) }
.stack > [data-derive-node] { height: 80px; flex: 0 0 80px; padding: 10px; border: 1px solid #ccd; box-sizing: border-box }
</style>
<section id="distributed" class="stack" data-derive-ready data-derive-region="distributed" data-derive-layout="stack">
  <article id="one" data-derive-node="one">One</article>
  <article id="two" data-derive-node="two">Two</article>
  <article id="three" data-derive-node="three">Three</article>
</section>`

const STRUCTURAL_RESIZE_EDGE_DOC = `<style>
body { font-family: sans-serif }
.region { width: 600px; padding: 12px; gap: 12px; margin-bottom: 24px }
.region > [data-derive-node] { min-height: 72px; padding: 12px; border: 1px solid #ccd; box-sizing: border-box }
.region > [data-derive-node][data-derive-width] { width: var(--derive-structural-width); max-width: none }
.region > [data-derive-node][data-derive-height] { height: var(--derive-structural-height); box-sizing: border-box }
.reverse { display: flex; flex-direction: column-reverse }
.wrapped { display: flex; flex-direction: column; flex-wrap: wrap }
.grid { display: grid; grid-template-columns: 1fr 1fr }
.overlap { display: grid; grid-template-columns: 1fr }
.overlap > [data-derive-node] { grid-row: 1 }
.columns { column-width: 200px }
.safe { display: flex; flex-direction: column }
.absolute { position: relative; min-height: 120px }
.absolute > #absolute-a { position: absolute; bottom: 0 }
.safe:has(#safe-a[data-derive-width="70"]) #reflow-target { height: 144px !important }
.safe:has(#safe-a[data-derive-width="64"]) #volatile-target { width: 72% !important }
.safe:has(#safe-a[data-derive-height="96"]) #height-volatile-target { width: 72% !important }
</style>
<section id="safe-region" class="region safe" data-derive-ready data-derive-region="safe" data-derive-layout="stack">
  <article id="safe-a" data-derive-node="safe-a" data-derive-width="50" style="--derive-structural-width: 50%">Safe A</article>
  <article id="transformed-target" data-derive-node="transformed-target" data-derive-width="62" style="--derive-structural-width: 62%; transform: scale(.95)">Transformed target</article>
  <article id="volatile-target" data-derive-node="volatile-target" data-derive-width="64" style="--derive-structural-width: 64%">Volatile target</article>
  <article id="height-volatile-target" data-derive-node="height-volatile-target" data-derive-width="66" style="--derive-structural-width: 66%">Height-volatile target</article>
  <article id="reflow-target" data-derive-node="reflow-target" data-derive-width="70" style="--derive-structural-width: 70%; height: 96px">Reflow target</article>
</section>
<section class="region reverse" data-derive-region="reverse" data-derive-layout="stack">
  <article id="reverse-a" data-derive-node="reverse-a">Reverse A</article>
  <article data-derive-node="reverse-b">Reverse B</article>
</section>
<section class="region grid" data-derive-region="grid" data-derive-layout="stack">
  <article id="grid-a" data-derive-node="grid-a">Grid A</article>
  <article data-derive-node="grid-b">Grid B</article>
</section>
<section class="region wrapped" data-derive-region="wrapped" data-derive-layout="stack">
  <article id="wrapped-a" data-derive-node="wrapped-a">Wrapped A</article>
  <article data-derive-node="wrapped-b">Wrapped B</article>
</section>
<section class="region absolute" data-derive-region="absolute" data-derive-layout="stack">
  <article id="absolute-a" data-derive-node="absolute-a">Absolute A</article>
  <article data-derive-node="absolute-b">Absolute B</article>
</section>
<section class="region overlap" data-derive-region="overlap" data-derive-layout="stack">
  <article id="overlap-a" data-derive-node="overlap-a">Overlap A</article>
  <article data-derive-node="overlap-b">Overlap B</article>
</section>
<section class="region columns" data-derive-region="columns" data-derive-layout="stack">
  <article id="columns-a" data-derive-node="columns-a">Columns A</article>
  <article data-derive-node="columns-b">Columns B</article>
</section>`

const STRUCTURAL_RESIZE_TRANSACTION_DOC = `<style>
body { font-family: sans-serif }
.stack { width: 600px; padding: 10px; display: flex; flex-direction: column; gap: 10px }
.stack > [data-derive-node] { min-height: 40px; padding: 10px; border: 1px solid #ccd; box-sizing: border-box }
.stack > [data-derive-node][data-derive-width] { width: var(--derive-structural-width); max-width: none }
.stack > [data-derive-node][data-derive-height] { height: var(--derive-structural-height); box-sizing: border-box }
#owner { overflow: hidden }
#css-owner { height: 120px; overflow: hidden }
#guarded { max-width: 50% !important }
.mutated-during-resize { transform: scale(.9) }
</style>
<main id="outer" class="stack" data-derive-ready data-derive-region="outer" data-derive-layout="stack">
  <article id="owner" data-derive-node="owner" data-derive-height="120" style="--derive-structural-height: 120px">
    <section id="inner" class="stack" data-derive-region="inner" data-derive-layout="stack" data-derive-owner="owner">
      <div id="nested-child" data-derive-node="nested-child" data-derive-height="60" style="--derive-structural-height: 60px">Nested child</div>
    </section>
  </article>
  <article id="guarded" data-derive-node="guarded" data-derive-width="50" style="--derive-structural-width: 50%">Guarded width</article>
  <article id="css-owner" data-derive-node="css-owner">
    <section class="stack" data-derive-region="css-inner" data-derive-layout="stack" data-derive-owner="css-owner">
      <div id="css-child" data-derive-node="css-child" data-derive-height="60" style="--derive-structural-height: 60px">CSS-height child</div>
    </section>
  </article>
</main>`

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

test("structural diagonal and vertical resize snap on a scaled canvas and save atomically", async ({
  owner,
}) => {
  const shortId = await publishArtifact(
    owner,
    "structural-resize.html",
    STRUCTURAL_RESIZE_DOC,
    "text/html",
  )
  await openArtifact(owner, shortId)
  await expect(
    doc(owner).getByRole("button", { name: "Resize element width and height" }),
  ).toBeHidden()
  await expect(doc(owner).getByRole("slider", { name: "Resize element width" })).toBeHidden()
  await expect(doc(owner).getByRole("slider", { name: "Resize element height" })).toBeHidden()
  await enterEditMode(owner)

  const alpha = doc(owner).locator("#alpha")
  const bravo = doc(owner).locator("#bravo")
  await alpha.click()
  const widthHandle = doc(owner).getByRole("slider", { name: "Resize element width" })
  const heightHandle = doc(owner).getByRole("slider", { name: "Resize element height" })
  const corner = doc(owner).getByRole("button", { name: "Resize element width and height" })
  await expect(corner).toBeVisible()
  await expect(widthHandle).toHaveAttribute("aria-valuenow", "50")
  await expect(heightHandle).toHaveAttribute("aria-valuenow", "80")

  const grip = await corner.boundingBox()
  const start = await alpha.boundingBox()
  const target = await bravo.boundingBox()
  expect(grip).not.toBeNull()
  expect(start).not.toBeNull()
  expect(target).not.toBeNull()
  if (!grip || !start || !target) return
  await owner.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await owner.mouse.down()
  await owner.mouse.move(
    target.x + target.width,
    grip.y + grip.height / 2 + target.height - start.height,
  )
  await expect(doc(owner).locator(".derive-structure-snap-guide")).toHaveAttribute(
    "data-label",
    "Match bravo",
  )
  await expect(doc(owner).locator(".derive-structure-height-snap-guide")).toHaveAttribute(
    "data-label",
    "Match bravo height",
  )
  await owner.mouse.up()

  await expect(alpha).toHaveAttribute("data-derive-width", "68")
  await expect(alpha).toHaveAttribute("data-derive-height", "128")
  await expect(alpha).not.toHaveAttribute("data-derive-size")
  await expect(widthHandle).toHaveAttribute("aria-valuenow", "68")
  await expect(heightHandle).toHaveAttribute("aria-valuenow", "128")
  expect(await alpha.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
    "2s, 2s",
  )
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("1 unsaved change")

  await owner.getByTestId("inline-edit-undo").click()
  await expect(alpha).toHaveAttribute("data-derive-size", "compact")
  await expect(alpha).not.toHaveAttribute("data-derive-width")
  await expect(alpha).not.toHaveAttribute("data-derive-height")
  await expect(owner.getByTestId("inline-edit-redo")).toBeEnabled()
  // A tap/focus with no resize is not a transaction and must not fork history.
  await corner.click()
  await expect(owner.getByTestId("inline-edit-redo")).toBeEnabled()
  await owner.getByTestId("inline-edit-redo").click()
  await expect(alpha).toHaveAttribute("data-derive-width", "68")
  await expect(alpha).toHaveAttribute("data-derive-height", "128")

  // The dedicated vertical slider shares the same source model and history.
  await heightHandle.focus()
  await heightHandle.press("ArrowDown")
  await expect(alpha).toHaveAttribute("data-derive-height", "129")
  await owner.getByTestId("inline-edit-undo").click()
  await expect(alpha).toHaveAttribute("data-derive-height", "128")

  await owner.setViewportSize({ width: 390, height: 844 })
  for (const control of [widthHandle, heightHandle, corner]) {
    const box = await control.boundingBox()
    expect(box).not.toBeNull()
    if (!box) continue
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    expect(box.y + box.height).toBeLessThanOrEqual(844)
    expect(box.width).toBeGreaterThanOrEqual(24)
    expect(box.height).toBeGreaterThanOrEqual(24)
  }

  await owner.getByTestId("inline-edit-save").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()
  await expect(async () => {
    const source = await contentOf(owner, shortId)
    const opening = source.match(/<article id="alpha"[^>]*>/)?.[0]
    expect(opening).toContain('data-derive-width="68"')
    expect(opening).toContain('data-derive-height="128"')
    expect(opening).toContain("transition: width 2s ease, height 2s ease")
    expect(opening).toContain("--derive-structural-width: 68%")
    expect(opening).toContain("--derive-structural-height: 128px")
    expect(opening).not.toContain("data-derive-size")
  }).toPass({ timeout: 10_000 })
})

test("structural multi-select equalizes and reorders as atomic safe actions", async ({ owner }) => {
  const shortId = await publishArtifact(
    owner,
    "structural-multiselect.html",
    STRUCTURAL_MULTISELECT_DOC,
    "text/html",
  )
  await openArtifact(owner, shortId)
  const frame = doc(owner)
  await expect(frame.getByRole("button", { name: "Select all siblings" })).toBeHidden()
  await enterEditMode(owner)

  const alpha = frame.locator("#alpha")
  const bravo = frame.locator("#bravo")
  const nodes = frame.locator("#multi > [data-derive-node]")
  await bravo.click()
  const reorderGrip = frame.getByRole("button", { name: "Drag to reorder" })
  const gripBox = await reorderGrip.boundingBox()
  const charlieBox = await frame.locator("#charlie").boundingBox()
  expect(gripBox).not.toBeNull()
  expect(charlieBox).not.toBeNull()
  if (!gripBox || !charlieBox) return
  await owner.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2)
  await owner.mouse.down()
  await owner.mouse.move(charlieBox.x + charlieBox.width / 2, charlieBox.y + 2)
  await expect(frame.locator(".derive-structure-drop-marker")).toBeVisible()
  await expect(frame.locator(".derive-structure-drop-marker")).toHaveAttribute(
    "data-label",
    "Before charlie",
  )
  await owner.mouse.up()
  await expect(frame.locator(".derive-structure-drop-marker")).toBeHidden()
  await expect(nodes.nth(0)).toHaveAttribute("id", "alpha")
  await alpha.click({ modifiers: ["Shift"] })
  await expect(frame.locator(".derive-structure-label")).toHaveText("2 selected · alpha")
  await expect(frame.locator(".derive-structure-multi-box:visible")).toHaveCount(1)
  await expect(frame.getByRole("button", { name: "Drag to reorder" })).toBeDisabled()
  await expect(frame.getByRole("button", { name: "Remove element (Delete)" })).toBeDisabled()
  await expect(frame.getByRole("button", { name: "Compact size" })).toBeDisabled()
  await owner.keyboard.press("Delete")
  await expect(nodes).toHaveCount(4)

  await frame.getByRole("button", { name: "Open selected layout actions" }).click()
  await frame.getByRole("button", { name: "Match selected widths to the active element" }).click()
  await expect(bravo).toHaveAttribute("data-derive-width", "52")
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("1 unsaved change")
  await owner.getByTestId("inline-edit-undo").click()
  await expect(bravo).toHaveAttribute("data-derive-width", "68")
  await owner.getByTestId("inline-edit-redo").click()
  await expect(bravo).toHaveAttribute("data-derive-width", "52")
  await frame.getByRole("button", { name: "Align selected to center" }).click()
  await expect(alpha).toHaveAttribute("data-derive-align", "center")
  await expect(bravo).toHaveAttribute("data-derive-align", "center")
  await expect(alpha).toHaveCSS("align-self", "center")
  await owner.getByTestId("inline-edit-undo").click()
  await expect(alpha).not.toHaveAttribute("data-derive-align")
  await expect(bravo).not.toHaveAttribute("data-derive-align")
  await owner.getByTestId("inline-edit-redo").click()
  await expect(alpha).toHaveAttribute("data-derive-align", "center")

  // A non-contiguous selection advances stably as one action and one Undo restores
  // the complete sibling order instead of peeling off one member at a time.
  await bravo.click()
  await frame.locator("#delta").click({ modifiers: ["Shift"] })
  await frame.getByRole("button", { name: "Move earlier (Option+Up)" }).click()
  await expect(nodes.nth(0)).toHaveAttribute("id", "bravo")
  await expect(nodes.nth(1)).toHaveAttribute("id", "alpha")
  await expect(nodes.nth(2)).toHaveAttribute("id", "delta")
  await expect(nodes.nth(3)).toHaveAttribute("id", "charlie")
  await owner.getByTestId("inline-edit-undo").click()
  await expect(nodes.nth(0)).toHaveAttribute("id", "alpha")
  await expect(nodes.nth(1)).toHaveAttribute("id", "bravo")
  await expect(nodes.nth(2)).toHaveAttribute("id", "charlie")
  await expect(nodes.nth(3)).toHaveAttribute("id", "delta")

  // Equal-height is all-or-nothing. Delta's authored minimum makes Alpha's height
  // unsafe, so no peer may retain a partial preview from the rejected batch.
  await alpha.click()
  await frame.getByRole("button", { name: "Select all siblings" }).click()
  await frame.getByRole("button", { name: "Open selected layout actions" }).click()
  await frame.getByRole("button", { name: "Match selected heights to the active element" }).click()
  await expect(bravo).toHaveAttribute("data-derive-height", "112")
  await expect(frame.locator("#charlie")).not.toHaveAttribute("data-derive-height")
  await expect(frame.locator("#delta")).not.toHaveAttribute("data-derive-height")
  await expect(frame.locator(".derive-structure-toast")).toContainText(
    "Content or authored constraints prevent matching these heights",
  )

  // Escape collapses the group before navigating hierarchy. A safe two-node batch
  // then becomes one undoable height action.
  await owner.keyboard.press("Escape")
  await bravo.click()
  await alpha.click({ modifiers: ["Shift"] })
  await frame.getByRole("button", { name: "Open selected layout actions" }).click()
  await frame.getByRole("button", { name: "Match selected heights to the active element" }).click()
  await expect(bravo).toHaveAttribute("data-derive-height", "96")
  await owner.getByTestId("inline-edit-undo").click()
  await expect(bravo).toHaveAttribute("data-derive-height", "112")
  await owner.getByTestId("inline-edit-redo").click()
  await expect(bravo).toHaveAttribute("data-derive-height", "96")
  await frame.getByRole("button", { name: "Fit selected heights to their content" }).click()
  await expect(alpha).not.toHaveAttribute("data-derive-height")
  await expect(bravo).not.toHaveAttribute("data-derive-height")
  await owner.getByTestId("inline-edit-undo").click()
  await expect(alpha).toHaveAttribute("data-derive-height", "96")
  await expect(bravo).toHaveAttribute("data-derive-height", "96")
  await owner.getByTestId("inline-edit-redo").click()
  await expect(alpha).not.toHaveAttribute("data-derive-height")

  // Modifier selection cannot leak across authored regions.
  await frame.locator("#echo").click({ modifiers: ["Shift"] })
  await expect(frame.locator(".derive-structure-label")).toHaveText("echo")
  await expect(frame.locator(".derive-structure-multi-box:visible")).toHaveCount(0)

  // Keep the batch toolbar reachable on the compact canvas where it is densest.
  await owner.setViewportSize({ width: 390, height: 844 })
  await bravo.evaluate((el) => (el as HTMLElement).focus())
  await alpha.click({ modifiers: ["Shift"] })
  const toolbar = await frame.locator(".derive-structure-toolbar").boundingBox()
  expect(toolbar).not.toBeNull()
  if (!toolbar) return
  expect(toolbar.x).toBeGreaterThanOrEqual(0)
  expect(toolbar.x + toolbar.width).toBeLessThanOrEqual(390)
  expect(toolbar.y).toBeGreaterThanOrEqual(0)
  expect(toolbar.y + toolbar.height).toBeLessThanOrEqual(844)

  await frame.getByRole("button", { name: "Move later (Option+Down)" }).click()
  await owner.getByTestId("inline-edit-save").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()
  await expect(async () => {
    const source = await contentOf(owner, shortId)
    expect(source.indexOf('data-derive-node="charlie"')).toBeLessThan(
      source.indexOf('data-derive-node="alpha"'),
    )
    const bravoOpening = source.match(/<article id="bravo"[^>]*>/)?.[0]
    expect(bravoOpening).toContain('data-derive-width="52"')
    expect(bravoOpening).toContain('data-derive-align="center"')
    expect(bravoOpening).toContain("--derive-structural-width: 52%")
    expect(bravoOpening).toContain("--derive-structural-align: center")
    expect(bravoOpening).not.toContain("data-derive-height")
    expect(bravoOpening).not.toContain("--derive-structural-height")
  }).toPass({ timeout: 10_000 })
})

test("structural health coach explains a blocked layout action and applies the safe fix", async ({
  owner,
}) => {
  const shortId = await publishArtifact(
    owner,
    "structural-health-coach.html",
    STRUCTURAL_MULTISELECT_DOC,
    "text/html",
  )
  await openArtifact(owner, shortId)
  await enterEditMode(owner)
  const frame = doc(owner)
  await frame.locator("#alpha").click()
  await frame.locator("#bravo").click({ modifiers: ["Shift"] })
  await expect(frame.locator(".derive-structure-box")).toHaveAttribute(
    "data-interaction-state",
    "selected",
  )
  await frame.getByRole("button", { name: "Open selected layout actions" }).click()
  await frame
    .getByRole("button", { name: "Check layout health and suggest the nearest safe fix" })
    .click()
  await expect(frame.locator(".derive-structure-toast")).toContainText(
    "Select all 4 siblings to distribute spacing",
  )
  await frame.getByRole("button", { name: "Select all", exact: true }).click()
  await expect(frame.locator(".derive-structure-label")).toContainText("4 selected")
})

test("responsive edit previews use the real iframe viewport and label health checks", async ({
  owner,
}) => {
  const shortId = await publishArtifact(
    owner,
    "structural-responsive-preview.html",
    STRUCTURAL_MULTISELECT_DOC,
    "text/html",
  )
  await openArtifact(owner, shortId)
  await expect(owner.getByTestId("inline-edit-viewports")).toBeHidden()
  await enterEditMode(owner)

  const iframe = owner.locator("iframe[title]")
  const frame = doc(owner)
  await owner.getByTestId("inline-edit-viewport-mobile").click()
  await expect(iframe).toHaveAttribute("data-preview-width", "390")
  await expect.poll(async () => (await iframe.boundingBox())?.width).toBeCloseTo(390, 0)
  await expect
    .poll(() =>
      frame
        .locator("body")
        .evaluate((el) => getComputedStyle(el).getPropertyValue("--dogfood-breakpoint").trim()),
    )
    .toBe("mobile")

  await frame.locator("#alpha").click()
  await frame.locator("#bravo").click({ modifiers: ["Shift"] })
  await frame.getByRole("button", { name: "Open selected layout actions" }).click()
  await frame
    .getByRole("button", { name: "Check layout health and suggest the nearest safe fix" })
    .click()
  await expect(frame.locator(".derive-structure-toast")).toContainText("Mobile · 390px:")

  await owner.getByTestId("inline-edit-viewport-tablet").click()
  await expect(iframe).toHaveAttribute("data-preview-width", "768")
  await expect.poll(async () => (await iframe.boundingBox())?.width).toBeCloseTo(768, 0)
  await expect
    .poll(() =>
      frame
        .locator("body")
        .evaluate((el) => getComputedStyle(el).getPropertyValue("--dogfood-breakpoint").trim()),
    )
    .toBe("")
  await owner.getByTestId("inline-edit-done").click()
  await expect(owner.getByTestId("inline-edit-viewports")).toBeHidden()
})

test("design intent previews exact operations and applies as one reversible transaction", async ({
  owner,
}) => {
  const shortId = await publishArtifact(
    owner,
    "structural-design-intent.html",
    STRUCTURAL_MULTISELECT_DOC,
    "text/html",
  )
  await openArtifact(owner, shortId)
  await enterEditMode(owner)
  const frame = doc(owner)
  const alpha = frame.locator("#alpha")
  const bravo = frame.locator("#bravo")

  await alpha.click()
  await bravo.click({ modifiers: ["Shift"] })
  await frame.getByRole("button", { name: "Open selected layout actions" }).click()
  await frame.getByRole("button", { name: "Preview a safe design-intent plan" }).click()
  await expect(frame.locator(".derive-structure-intent-receipt")).toContainText(
    "50% local rail · fit 2 fixed heights · center alignment",
  )
  await expect(alpha).toHaveAttribute("data-derive-width", "52")
  await expect(bravo).toHaveAttribute("data-derive-width", "68")

  await frame.getByRole("button", { name: "Make the active element dominant" }).click()
  await expect(frame.locator(".derive-structure-intent-receipt")).toContainText(
    "active 75% · 1 peer 50% · fit content · start alignment",
  )
  await frame.getByRole("button", { name: "Apply this design intent plan" }).click()
  await expect(alpha).toHaveAttribute("data-derive-width", "50")
  await expect(bravo).toHaveAttribute("data-derive-width", "75")
  await expect(alpha).not.toHaveAttribute("data-derive-height")
  await expect(bravo).not.toHaveAttribute("data-derive-height")
  await expect(alpha).toHaveAttribute("data-derive-align", "start")
  await expect(bravo).toHaveAttribute("data-derive-align", "start")
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("1 unsaved change")

  await owner.getByTestId("inline-edit-undo").click()
  await expect(alpha).toHaveAttribute("data-derive-width", "52")
  await expect(bravo).toHaveAttribute("data-derive-width", "68")
  await expect(alpha).toHaveAttribute("data-derive-height", "96")
  await expect(bravo).toHaveAttribute("data-derive-height", "112")
  await expect(alpha).not.toHaveAttribute("data-derive-align")
  await expect(bravo).not.toHaveAttribute("data-derive-align")

  await owner.getByTestId("inline-edit-redo").click()
  await expect(alpha).toHaveAttribute("data-derive-width", "50")
  await expect(bravo).toHaveAttribute("data-derive-width", "75")
  await expect(alpha).not.toHaveAttribute("data-derive-height")
  await expect(bravo).not.toHaveAttribute("data-derive-height")
  await expect(alpha).toHaveAttribute("data-derive-align", "start")
  await expect(bravo).toHaveAttribute("data-derive-align", "start")

  await owner.getByTestId("inline-edit-save").click()
  await expect(async () => {
    const source = await contentOf(owner, shortId)
    const alphaOpening = source.match(/<article id="alpha"[^>]*>/)?.[0]
    const bravoOpening = source.match(/<article id="bravo"[^>]*>/)?.[0]
    expect(alphaOpening).toContain('data-derive-width="50"')
    expect(bravoOpening).toContain('data-derive-width="75"')
    expect(alphaOpening).toContain('data-derive-align="start"')
    expect(bravoOpening).toContain('data-derive-align="start"')
    expect(alphaOpening).not.toContain("data-derive-height")
    expect(bravoOpening).not.toContain("data-derive-height")
  }).toPass({ timeout: 10_000 })
})

test("structural exact sizing commits both axes as one source-safe action", async ({ owner }) => {
  const shortId = await publishArtifact(
    owner,
    "structural-exact-size.html",
    STRUCTURAL_MULTISELECT_DOC,
    "text/html",
  )
  await openArtifact(owner, shortId)
  await enterEditMode(owner)
  const frame = doc(owner)
  const bravo = frame.locator("#bravo")
  await bravo.click()
  await frame.getByRole("button", { name: "Set exact width and height" }).click()
  await frame.locator(".derive-structure-precision-field").nth(0).locator("input").fill("63")
  await frame.locator(".derive-structure-precision-field").nth(1).locator("input").fill("118")
  await frame.getByRole("button", { name: "Apply exact width and height" }).click()
  await expect(bravo).toHaveAttribute("data-derive-width", "63")
  await expect(bravo).toHaveAttribute("data-derive-height", "118")
  await owner.getByTestId("inline-edit-undo").click()
  await expect(bravo).toHaveAttribute("data-derive-width", "68")
  await expect(bravo).toHaveAttribute("data-derive-height", "112")
  await owner.getByTestId("inline-edit-redo").click()
  await expect(bravo).toHaveAttribute("data-derive-width", "63")
  await expect(bravo).toHaveAttribute("data-derive-height", "118")
  await owner.getByTestId("inline-edit-save").click()
  await expect(async () => {
    const source = await contentOf(owner, shortId)
    const opening = source.match(/<article id="bravo"[^>]*>/)?.[0]
    expect(opening).toContain('data-derive-width="63"')
    expect(opening).toContain('data-derive-height="118"')
    expect(opening).toContain("--derive-structural-width: 63%")
    expect(opening).toContain("--derive-structural-height: 118px")
  }).toPass({ timeout: 10_000 })
})

test("structural distribution fills a bounded stack as one reversible action", async ({
  owner,
}) => {
  const shortId = await publishArtifact(
    owner,
    "structural-distribution.html",
    STRUCTURAL_DISTRIBUTE_DOC,
    "text/html",
  )
  await openArtifact(owner, shortId)
  await enterEditMode(owner)
  const frame = doc(owner)
  const region = frame.locator("#distributed")
  await frame.locator("#one").click()
  await frame.getByRole("button", { name: "Select all siblings" }).click()
  await frame.getByRole("button", { name: "Open selected layout actions" }).click()
  await frame.getByRole("button", { name: "Distribute all siblings vertically" }).click()
  await expect(region).toHaveAttribute("data-derive-gap", "118")
  await expect(region).toHaveCSS("row-gap", "118px")
  await owner.getByTestId("inline-edit-undo").click()
  await expect(region).not.toHaveAttribute("data-derive-gap")
  await expect(region).toHaveCSS("row-gap", "12px")
  await owner.getByTestId("inline-edit-redo").click()
  await expect(region).toHaveAttribute("data-derive-gap", "118")
  await owner.getByTestId("inline-edit-save").click()
  await expect(async () => {
    const source = await contentOf(owner, shortId)
    const opening = source.match(/<section id="distributed"[^>]*>/)?.[0]
    expect(opening).toContain('data-derive-gap="118"')
    expect(opening).toContain("--derive-structural-gap: 118px")
  }).toPass({ timeout: 10_000 })
})

test("structural resize fails closed for ambiguous layouts and unsafe snap targets", async ({
  owner,
}) => {
  const shortId = await publishArtifact(
    owner,
    "structural-resize-edges.html",
    STRUCTURAL_RESIZE_EDGE_DOC,
    "text/html",
  )
  await openArtifact(owner, shortId)
  await enterEditMode(owner)

  const widthHandle = doc(owner).getByRole("slider", { name: "Resize element width" })
  const heightHandle = doc(owner).getByRole("slider", { name: "Resize element height" })
  const corner = doc(owner).getByRole("button", { name: "Resize element width and height" })

  await doc(owner).locator("#reverse-a").click()
  await expect(widthHandle).toBeDisabled()
  await expect(heightHandle).toBeDisabled()
  await expect(corner).toBeDisabled()
  await widthHandle.press("ArrowRight")
  await expect(doc(owner).locator("#reverse-a")).not.toHaveAttribute("data-derive-width")

  await doc(owner).locator("#grid-a").click()
  await expect(widthHandle).toBeDisabled()
  await expect(heightHandle).toBeDisabled()
  await expect(corner).toBeDisabled()

  for (const selector of ["#wrapped-a", "#absolute-a", "#overlap-a", "#columns-a"]) {
    await doc(owner).locator(selector).click()
    await expect(widthHandle).toBeDisabled()
    await expect(heightHandle).toBeDisabled()
    await expect(corner).toBeDisabled()
  }

  const selected = doc(owner).locator("#safe-a")
  await selected.click()
  await expect(widthHandle).toBeEnabled()
  await expect(heightHandle).toBeEnabled()
  await expect(corner).toBeEnabled()
  const grip = await widthHandle.boundingBox()
  const region = await doc(owner).locator("#safe-region").boundingBox()
  expect(grip).not.toBeNull()
  expect(region).not.toBeNull()
  if (!grip || !region) return
  await owner.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await owner.mouse.down()
  await owner.mouse.move(grip.x + grip.width / 2 + region.width * 0.12, grip.y + grip.height / 2)
  await expect(doc(owner).locator(".derive-structure-snap-guide")).toBeHidden()
  await owner.mouse.up()
  await expect(selected).toHaveAttribute("data-derive-width", "62")

  // If applying a tentative same-axis snap invalidates that target, use the
  // rounded unsnapped value for the event instead of committing a hidden snap.
  await owner.getByTestId("inline-edit-undo").click()
  await expect(selected).toHaveAttribute("data-derive-width", "50")
  const contentWidth = await doc(owner)
    .locator("#safe-region")
    .evaluate((element) => {
      const html = element as HTMLElement
      const style = getComputedStyle(html)
      return (
        html.clientWidth -
        (Number.parseFloat(style.paddingLeft) || 0) -
        (Number.parseFloat(style.paddingRight) || 0)
      )
    })
  const volatileGrip = await widthHandle.boundingBox()
  expect(volatileGrip).not.toBeNull()
  if (!volatileGrip) return
  await owner.mouse.move(
    volatileGrip.x + volatileGrip.width / 2,
    volatileGrip.y + volatileGrip.height / 2,
  )
  await owner.mouse.down()
  await owner.mouse.move(
    volatileGrip.x + volatileGrip.width / 2 + contentWidth * 0.128,
    volatileGrip.y + volatileGrip.height / 2,
  )
  await expect(doc(owner).locator(".derive-structure-snap-guide")).toBeHidden()
  await owner.mouse.up()
  await expect(selected).toHaveAttribute("data-derive-width", "63")

  // Height-dependent CSS can invalidate an earlier width snap in the same
  // diagonal event; final-state reconciliation must fall back symmetrically.
  await owner.getByTestId("inline-edit-undo").click()
  await expect(selected).toHaveAttribute("data-derive-width", "50")
  const heightVolatileTarget = doc(owner).locator("#height-volatile-target")
  const symmetricGrip = await corner.boundingBox()
  const symmetricStart = await selected.boundingBox()
  const symmetricHeight = await doc(owner).locator("#reflow-target").boundingBox()
  expect(symmetricGrip).not.toBeNull()
  expect(symmetricStart).not.toBeNull()
  expect(symmetricHeight).not.toBeNull()
  if (!symmetricGrip || !symmetricStart || !symmetricHeight) return
  await owner.mouse.move(
    symmetricGrip.x + symmetricGrip.width / 2,
    symmetricGrip.y + symmetricGrip.height / 2,
  )
  await owner.mouse.down()
  await owner.mouse.move(
    symmetricGrip.x + symmetricGrip.width / 2 + contentWidth * 0.154,
    symmetricGrip.y + symmetricGrip.height / 2 + symmetricHeight.height - symmetricStart.height,
  )
  await expect(doc(owner).locator(".derive-structure-snap-guide")).toBeHidden()
  await expect(doc(owner).locator(".derive-structure-height-snap-guide")).toHaveAttribute(
    "data-label",
    "Match reflow-target height",
  )
  await owner.mouse.up()
  await expect(selected).toHaveAttribute("data-derive-width", "65")
  await expect(selected).toHaveAttribute("data-derive-height", "96")
  await expect(heightVolatileTarget).toHaveCSS("width", "432px")

  // A width snap can reflow a height target during the same diagonal move. The
  // old height must not remain a stale snap candidate or leave a false guide.
  await owner.getByTestId("inline-edit-undo").click()
  await expect(selected).toHaveAttribute("data-derive-width", "50")
  const reflowTarget = doc(owner).locator("#reflow-target")
  const beforeReflow = await reflowTarget.boundingBox()
  const diagonalGrip = await corner.boundingBox()
  const selectedBox = await selected.boundingBox()
  expect(beforeReflow).not.toBeNull()
  expect(diagonalGrip).not.toBeNull()
  expect(selectedBox).not.toBeNull()
  if (!beforeReflow || !diagonalGrip || !selectedBox) return
  await owner.mouse.move(
    diagonalGrip.x + diagonalGrip.width / 2,
    diagonalGrip.y + diagonalGrip.height / 2,
  )
  await owner.mouse.down()
  await owner.mouse.move(
    diagonalGrip.x + diagonalGrip.width / 2 + region.width * 0.2,
    diagonalGrip.y + diagonalGrip.height / 2 + beforeReflow.height - selectedBox.height,
  )
  await expect(doc(owner).locator(".derive-structure-snap-guide")).toHaveAttribute(
    "data-label",
    "Match reflow-target",
  )
  await expect(doc(owner).locator(".derive-structure-height-snap-guide")).toBeHidden()
  await owner.mouse.up()
  await expect(selected).toHaveAttribute("data-derive-width", "70")
  await expect(selected).toHaveAttribute("data-derive-height", "96")
  await expect(reflowTarget).toHaveCSS("height", "144px")
})

test("structural resize transactions cancel safely and preserve nested constraints", async ({
  owner,
}) => {
  const shortId = await publishArtifact(
    owner,
    "structural-resize-transactions.html",
    STRUCTURAL_RESIZE_TRANSACTION_DOC,
    "text/html",
  )
  await openArtifact(owner, shortId)
  await enterEditMode(owner)

  const frame = doc(owner)
  const ownerNode = frame.locator("#owner")
  const guarded = frame.locator("#guarded")
  const widthHandle = frame.getByRole("slider", { name: "Resize element width" })
  const heightHandle = frame.getByRole("slider", { name: "Resize element height" })

  // Discard must restore the height attribute as well as its custom property,
  // otherwise the next structural scan fails closed on a mismatched source pair.
  await frame.locator("#nested-child").click()
  await frame.getByRole("button", { name: "Select containing group (Escape)" }).click()
  await heightHandle.focus()
  await heightHandle.press("ArrowDown")
  await expect(ownerNode).toHaveAttribute("data-derive-height", "121")
  await owner.getByTestId("inline-edit-discard").click()
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("click text to edit")
  await owner.getByTestId("inline-edit-done").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()
  await enterEditMode(owner)
  await frame.locator("#nested-child").click()
  await frame.getByRole("button", { name: "Select containing group (Escape)" }).click()
  await expect(heightHandle).toBeVisible()
  await expect(ownerNode).toHaveAttribute("data-derive-height", "120")

  // A constrained temporary preview must never be serialized by a keyboard save
  // while its pointer transaction is still active.
  // The owner's toolbar sits directly over the next sibling. Select the guarded
  // node from its unobscured lower edge, matching how a user can reach it.
  const guardedBox = await guarded.boundingBox()
  expect(guardedBox).not.toBeNull()
  if (!guardedBox) return
  await owner.mouse.click(guardedBox.x + 8, guardedBox.y + guardedBox.height - 8)
  const grip = await widthHandle.boundingBox()
  const outer = await frame.locator("#outer").boundingBox()
  expect(grip).not.toBeNull()
  expect(outer).not.toBeNull()
  if (!grip || !outer) return
  await owner.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await owner.mouse.down()
  await owner.mouse.move(grip.x + grip.width / 2 + outer.width * 0.2, grip.y + grip.height / 2)
  await owner.keyboard.press("Control+s")
  await expect(guarded).toHaveAttribute("data-derive-width", "50")
  await expect(owner.getByTestId("inline-edit-bar")).toBeVisible()
  await owner.mouse.up()

  // Secondary-button starts are ignored.
  await owner.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await owner.mouse.down({ button: "right" })
  await owner.mouse.move(grip.x + grip.width / 2 + outer.width * 0.1, grip.y + grip.height / 2)
  await owner.mouse.up({ button: "right" })
  await expect(guarded).toHaveAttribute("data-derive-width", "50")

  // Lost capture and a newly unsupported transform both restore the transaction.
  await owner.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await owner.mouse.down()
  await owner.mouse.move(grip.x + grip.width / 2 + outer.width * 0.1, grip.y + grip.height / 2)
  await widthHandle.evaluate((element) =>
    element.dispatchEvent(new PointerEvent("lostpointercapture")),
  )
  await owner.mouse.up()
  await expect(guarded).toHaveAttribute("data-derive-width", "50")

  await owner.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await owner.mouse.down()
  await owner.mouse.move(grip.x + grip.width / 2 + outer.width * 0.1, grip.y + grip.height / 2)
  await guarded.evaluate((element) => element.classList.add("mutated-during-resize"))
  await owner.mouse.up()
  await expect(guarded).toHaveAttribute("data-derive-width", "50")
  await guarded.evaluate((element) => element.classList.remove("mutated-during-resize"))

  await guarded.evaluate((element) => (element as HTMLElement).blur())
  await guarded.focus()
  await expect(widthHandle).toBeVisible()
  const mutationGrip = await widthHandle.boundingBox()
  expect(mutationGrip).not.toBeNull()
  if (!mutationGrip) return
  await owner.mouse.move(
    mutationGrip.x + mutationGrip.width / 2,
    mutationGrip.y + mutationGrip.height / 2,
  )
  await owner.mouse.down()
  await owner.mouse.move(
    mutationGrip.x + mutationGrip.width / 2 + outer.width * 0.1,
    mutationGrip.y + mutationGrip.height / 2,
  )
  await expect(guarded).not.toHaveAttribute("data-derive-width", "50")
  await guarded.evaluate((element) => element.setAttribute("data-derive-width", "90"))
  await owner.mouse.up()
  await expect(guarded).toHaveAttribute("data-derive-width", "50")

  // Growing a nested child may not make an already-sized owner clip. Accepted
  // steps remain undoable; the first clipping step rolls back by itself.
  const child = frame.locator("#nested-child")
  await child.click()
  await heightHandle.focus()
  for (let i = 0; i < 12; i++) await heightHandle.press("Shift+ArrowDown")
  const clips = await ownerNode.evaluate((element) => {
    const html = element as HTMLElement
    return html.scrollHeight > html.clientHeight + 1
  })
  expect(clips).toBe(false)
  expect(Number(await child.getAttribute("data-derive-height"))).toBeLessThan(156)

  // CSS-authored fixed-height ancestors are equally capable of clipping a
  // nested resize and must fail closed even without data-derive-height.
  const cssOwner = frame.locator("#css-owner")
  const cssChild = frame.locator("#css-child")
  await cssChild.click()
  await heightHandle.focus()
  for (let i = 0; i < 12; i++) await heightHandle.press("Shift+ArrowDown")
  const cssClips = await cssOwner.evaluate((element) => {
    const html = element as HTMLElement
    return html.scrollHeight > html.clientHeight + 1
  })
  expect(cssClips).toBe(false)
  expect(Number(await cssChild.getAttribute("data-derive-height"))).toBeLessThan(156)
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

/* === LaTeX papers ==========================================================
   The renderer marks math, tables, images, generated labels and the author block as
   read-only islands; the frame refuses them and steps the caret over them, while the
   prose, captions and headings around them edit like any document. A paper bundle
   edits its entry file and republishes with its other files carried over. */

const TEX = `\\documentclass{article}
\\begin{document}
\\section{Intro}
First sentence with math $E=mc^2$ after it.
\\begin{figure}
\\centering
\\caption{A caption to edit.}
\\end{figure}
\\begin{table}
\\centering
\\begin{tabular}{lr}
Method & PSNR \\\\
Baseline & 21.4 \\\\
\\end{tabular}
\\caption{Numbers.}
\\end{table}
\\end{document}
`

async function seedTex(page: Page) {
  const shortId = await publishArtifact(page, "paper.tex", TEX, "text/x-latex")
  await openArtifact(page, shortId)
  return shortId
}
// The frame is titled after the artifact (a .tex upload names it by its file stem).
const paper = (page: Page) => page.frameLocator('iframe[title="paper"]')
const READONLY_TOAST = "can't be edited inline"

test("LaTeX: typing beside a formula edits the prose and leaves the math alone", async ({
  owner,
}) => {
  const shortId = await seedTex(owner)
  const p = paper(owner).locator("p").first()
  await expect(p.locator(".katex").first()).toBeVisible()
  await enterEditMode(owner)
  // Click the first word, not the centre of the line (that could be the formula).
  await p.click({ position: { x: 6, y: 8 } })
  await owner.keyboard.press("End")
  await owner.keyboard.type(" Amended.")
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("1 unsaved change")
  await owner.getByTestId("inline-edit-save").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()
  // The owner published v1 moments ago, so the edit coalesces into it: read the source.
  await expect(async () => {
    expect(await contentOf(owner, shortId)).toContain("after it. Amended.")
  }).toPass()
  expect(await contentOf(owner, shortId)).toContain("$E=mc^2$")
})

test("LaTeX: a formula and a table cell are refused, a caption edits like prose", async ({
  owner,
}) => {
  const shortId = await seedTex(owner)
  await expect(paper(owner).locator(".katex").first()).toBeVisible()
  await enterEditMode(owner)
  await paper(owner).locator(".derive-math").first().click()
  await expect(owner.getByText(READONLY_TOAST)).toBeVisible()
  await paper(owner).getByRole("cell", { name: "Baseline" }).click()
  await expect(paper(owner).locator("[data-derive-editable]")).toHaveCount(0)

  const caption = paper(owner).locator("figcaption").first()
  await caption.click({ position: { x: 120, y: 8 } })
  await expect(caption).toHaveAttribute("contenteditable", /^(plaintext-only|true)$/)
  // The generated label is an inert island inside the armed caption.
  await expect(caption.locator(".derive-caption-label")).toHaveAttribute("contenteditable", "false")
  await owner.keyboard.press("End")
  await owner.keyboard.type(" More.")
  await owner.getByTestId("inline-edit-save").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()
  await expect(async () => {
    expect(await contentOf(owner, shortId)).toContain("\\caption{A caption to edit. More.}")
  }).toPass()
})

test("LaTeX: Backspace right after a formula cannot swallow it", async ({ owner }) => {
  const shortId = await seedTex(owner)
  const p = paper(owner).locator("p").first()
  await expect(p.locator(".katex").first()).toBeVisible()
  await enterEditMode(owner)
  await p.click({ position: { x: 6, y: 8 } })
  await p.evaluate((el) => {
    const after = el.querySelector(".derive-math")?.nextSibling
    if (!after) throw new Error("no text after the formula")
    const range = document.createRange()
    range.setStart(after, 0)
    range.collapse(true)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  })
  await owner.keyboard.press("Backspace")
  await expect(p.locator(".derive-math")).toHaveCount(1)
  await expect(p.locator(".katex")).toHaveCount(1)
  await expect(p).toContainText("First sentence with math")
  await expect(p).toContainText("after it.")
  await owner.getByTestId("inline-edit-done").click()
  expect(await versionOf(owner, shortId)).toBe(1)
})

const enc = (s: string) => new TextEncoder().encode(s)
const PAPER_MAIN = `\\documentclass{article}
\\begin{document}
\\section{Intro}
Bundle prose here \\cite{k}.
\\input{sec/method}
\\bibliography{refs}
\\end{document}
`
const PAPER_REFS = "@misc{k, title={Known}, author={A B}, year={2020}}\n"
const PAPER_SECTION = "Included method text.\n"
// A real 1x1 8-bit grayscale PNG (signature, IHDR, one deflated row, IEND): the publish
// path may sniff image bytes, so the figure has to be a genuine image, not a label.
const PAPER_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x00, 0x00, 0x00, 0x00, 0x3a, 0x7e, 0x9b,
  0x55, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00,
  0x02, 0x00, 0x01, 0x48, 0xaf, 0xa4, 0x71, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])
// Fourteen more figures beside fig/a.png: a folder card shows twelve rows and scrolls
// past that, so fig/ has to hold more than twelve.
const PAPER_EXTRA_FIGURES = Array.from(
  { length: 14 },
  (_, i) => `fig/b${String(i + 1).padStart(2, "0")}.png`,
)
const paperZip = () =>
  zipSync({
    "main.tex": enc(PAPER_MAIN),
    "refs.bib": enc(PAPER_REFS),
    "README.md": enc("# notes"),
    "sec/method.tex": enc(PAPER_SECTION),
    "sec/app/notes.tex": enc("Appendix notes.\n"),
    "fig/a.png": PAPER_PNG,
    ...Object.fromEntries(PAPER_EXTRA_FIGURES.map((path) => [path, PAPER_PNG])),
  })

test("LaTeX: a paper bundle edits main.tex on the page and keeps its other files", async ({
  owner,
}) => {
  const shortId = await publishArtifact(owner, "paper.zip", paperZip(), "application/zip")
  await openArtifact(owner, shortId)
  await enterEditMode(owner)
  const p = paper(owner).locator("p").first()
  await p.click({ position: { x: 6, y: 8 } })
  await owner.keyboard.press("End")
  await owner.keyboard.type(" Amended.")
  await owner.getByTestId("inline-edit-save").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()
  const mainOf = async () =>
    (
      (await (await owner.request.get(`/v1/artifacts/${shortId}/files/main.tex`)).json()) as {
        source: string
      }
    ).source
  // Typed right after the citation: the label word-snaps into the edit, and the server
  // leaves it alone. The owner published moments ago, so the edit coalesces into v1.
  await expect(async () => {
    expect(await mainOf()).toContain("here \\cite{k}. Amended.")
  }).toPass()
  const detail = (await (await owner.request.get(`/v1/artifacts/${shortId}`)).json()) as {
    current_content_type: string
    bundle: { files: { path: string }[] }
  }
  expect(detail.current_content_type).toBe("derive/latex")
  expect(detail.bundle.files.map((f) => f.path).sort()).toEqual([
    "README.md",
    "fig/a.png",
    ...PAPER_EXTRA_FIGURES,
    "main.tex",
    "refs.bib",
    "sec/app/notes.tex",
    "sec/method.tex",
  ])
})

test("LaTeX: the References tab adds an entry as a new version", async ({ owner }) => {
  const shortId = await publishArtifact(owner, "paper.zip", paperZip(), "application/zip")
  await openArtifact(owner, shortId)
  await owner.getByTestId("rail-tab-references").click()
  await expect(owner.getByTestId("references-entry-k")).toContainText("cited")
  await owner.getByTestId("references-add").click()
  await owner
    .getByTestId("references-editor")
    .fill("@misc{added, title={Added}, author={X Y}, year={2025}}")
  await owner.getByTestId("references-save").click()
  await expect(owner.getByTestId("references-entry-added")).toBeVisible()
  await expect(async () => {
    expect(await versionOf(owner, shortId)).toBe(2)
  }).toPass()
  const refs = await (await owner.request.get(`/v1/artifacts/${shortId}/files/refs.bib`)).json()
  expect((refs as { source: string }).source).toBe(
    `${PAPER_REFS}\n@misc{added, title={Added}, author={X Y}, year={2025}}\n`,
  )
})

/* === The paper file bar + source editor ====================================
   A paper's bar lists its files as chips: the entry first, then the root files, then one
   chip per folder whose card (a small tree, opened by hover, pinned by a click) holds the
   folder's files. The bar stays up while the source editor is open, so the chips are how
   you move between files; the preview renders the whole paper with the open file's draft
   substituted, and a dirty editor asks before it drops typed text. */

const openPaper = async (page: Page) => {
  const shortId = await publishArtifact(page, "paper.zip", paperZip(), "application/zip")
  await openArtifact(page, shortId)
  return shortId
}
const preview = (page: Page) => page.frameLocator('[data-testid="artifact-preview"]')
const editor = (page: Page) => page.locator(".cm-content")
// A root file is a chip; a nested one is a row in its root folder's card, which opens on
// hover. Either way the bar says where the editor is: the chip's aria-current, or the
// folder chip's data-active.
const openFile = async (page: Page, path: string) => {
  const root = path.split("/")[0] ?? path
  if (root === path) {
    await page.getByTestId(`bundle-edit-${path}`).click()
    await expect(editor(page)).toBeVisible()
    await expect(page.getByTestId(`bundle-edit-${path}`)).toHaveAttribute("aria-current", "true")
    return
  }
  await page.getByTestId(`bundle-folder-${root}`).hover()
  await page.getByTestId(`bundle-tree-${path}`).click()
  await expect(editor(page)).toBeVisible()
  await expect(page.getByTestId(`bundle-folder-${root}`)).toHaveAttribute("data-active", "true")
}
// Type at the end of the open file (the caret lands wherever the click did).
const typeAtEnd = async (page: Page, text: string) => {
  await editor(page).click()
  await page.keyboard.press("Control+End")
  await page.keyboard.type(text)
}

test("LaTeX: the bar lists the entry first, root files as chips and each folder as a card", async ({
  owner,
}) => {
  await openPaper(owner)
  const bar = owner.getByTestId("bundle-bar")
  await expect(bar.locator('[data-testid^="bundle-edit-"]').first()).toHaveText("main.tex")
  // A root README is repository notes, not part of the paper: no chip, file kept.
  await expect(owner.getByTestId("bundle-edit-README.md")).toHaveCount(0)
  await expect(owner.getByTestId("bundle-edit-refs.bib")).toBeVisible()
  const fig = owner.getByTestId("bundle-folder-fig")
  const sec = owner.getByTestId("bundle-folder-sec")
  await expect(fig).toHaveAttribute("aria-expanded", "false")
  await expect(sec).toHaveAttribute("aria-expanded", "false")
  await expect(bar.getByText("fig/a.png")).toHaveCount(0)

  // Pointing at a folder chip opens its card (the row itself never reflows); a figure
  // in it is a link to the raw file in a new tab.
  await fig.hover()
  const figure = owner.getByTestId("bundle-open-fig/a.png")
  await expect(figure).toBeVisible()
  await expect(figure).toHaveAttribute("href", /\/raw\/.+\/fig\/a\.png$/)
  await expect(figure).toHaveAttribute("target", "_blank")
  // Fifteen figures, twelve rows: the list scrolls rather than the card growing.
  const list = owner.locator('[data-slot="popover-content"] ul[role="tree"]')
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  // Leaving closes the card after a beat...
  await owner.mouse.move(0, 0)
  await expect(figure).toBeHidden()
  // ...unless a click pinned it.
  await fig.click()
  await owner.mouse.move(0, 0)
  await owner.waitForTimeout(400)
  await expect(fig).toHaveAttribute("aria-expanded", "true")
  await expect(figure).toBeVisible()

  // A nested folder expands in place inside the card, and a row opens the editor.
  await sec.hover()
  await expect(owner.getByTestId("bundle-tree-sec/method.tex")).toBeVisible()
  const app = owner.getByTestId("bundle-folder-sec/app")
  await expect(app).toHaveAttribute("aria-expanded", "false")
  await app.click()
  const notes = owner.getByTestId("bundle-tree-sec/app/notes.tex")
  await expect(notes).toBeVisible()
  await notes.click()
  await expect(editor(owner)).toBeVisible()
  await expect(editor(owner)).toContainText("Appendix notes.")
  await expect(notes).toBeHidden()
  await expect(sec).toHaveAttribute("data-active", "true")
})

test("LaTeX: a section chip opens that file with the bar still up and previews it in the paper", async ({
  owner,
}) => {
  await openPaper(owner)
  await openFile(owner, "sec/method.tex")
  await expect(owner.getByTestId("bundle-bar")).toBeVisible()
  await expect(editor(owner)).toContainText("Included method text.")
  await expect(owner.getByTestId("bundle-edit-main.tex")).not.toHaveAttribute(
    "aria-current",
    "true",
  )
  // Reopening the card marks the row the editor holds.
  await owner.getByTestId("bundle-folder-sec").hover()
  await expect(owner.getByTestId("bundle-tree-sec/method.tex")).toHaveAttribute(
    "aria-current",
    "true",
  )
  await owner.mouse.move(0, 0)
  // The whole paper renders around the open file: the heading comes from main.tex, the
  // body from the draft of the section.
  const body = preview(owner).locator("body")
  await expect(body).toContainText("Intro")
  await expect(body).toContainText("Included method text.")
})

test("LaTeX: typing into a section re-renders the paper preview", async ({ owner }) => {
  await openPaper(owner)
  await openFile(owner, "sec/method.tex")
  const body = preview(owner).locator("body")
  await expect(body).toContainText("Included method text.")
  await typeAtEnd(owner, " Typed more.")
  await expect(body).toContainText("Included method text. Typed more.")
  await expect(body).toContainText("Intro")
})

test("LaTeX: switching files over unsaved text asks first, then opens the other file", async ({
  owner,
}) => {
  await openPaper(owner)
  await openFile(owner, "sec/method.tex")
  await typeAtEnd(owner, " Unsaved.")
  await owner.getByTestId("bundle-edit-main.tex").click()
  await expect(owner.getByTestId("source-edit-discard-confirm")).toBeVisible()
  await expect(owner.getByTestId("source-edit-discard-confirm")).toContainText("sec/method.tex")
  // The editor still holds the section until the question is answered.
  await expect(owner.getByTestId("bundle-folder-sec")).toHaveAttribute("data-active", "true")
  await owner.getByTestId("source-edit-discard").click()
  await expect(owner.getByTestId("source-edit-discard-confirm")).toBeHidden()
  await expect(owner.getByTestId("bundle-edit-main.tex")).toHaveAttribute("aria-current", "true")
  await expect(owner.getByTestId("bundle-folder-sec")).not.toHaveAttribute("data-active", "true")
  await expect(editor(owner)).toContainText("\\bibliography{refs}")
  await expect(editor(owner)).not.toContainText("Unsaved.")
})

test("LaTeX: Cancel over unsaved text asks first, and discarding closes the editor", async ({
  owner,
}) => {
  await openPaper(owner)
  await openFile(owner, "sec/method.tex")
  await typeAtEnd(owner, " Unsaved.")
  await owner.getByTestId("artifact-edit-cancel").click()
  await expect(owner.getByTestId("source-edit-discard-confirm")).toBeVisible()
  // Backing out keeps the editor and the typed text.
  await owner.getByTestId("confirm-dialog-cancel").click()
  await expect(owner.getByTestId("source-edit-discard-confirm")).toBeHidden()
  await expect(editor(owner)).toContainText("Unsaved.")
  await owner.getByTestId("artifact-edit-cancel").click()
  await owner.getByTestId("source-edit-discard").click()
  await expect(editor(owner)).toBeHidden()
  await expect(paper(owner).locator("p").first()).toBeVisible()
  // Nothing published: the paper is still v1 and the section is untouched.
  await expect(owner.getByTestId("bundle-folder-sec")).not.toHaveAttribute("data-active", "true")
})
