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
// A deck may mark its layout schema wrongly: here a node id the contract refuses (ids
// start with a letter). The layout scanner refuses that region; title and body text
// still save.
const PARTIAL_LAYOUT_DOC = `<section data-derive-slide="0" data-derive-region="slide-0" data-derive-layout="stack">
  <div data-derive-node="1-main"><h1 id="title">The original title for this slide.</h1>
    <p id="subtitle">The original supporting sentence.</p></div>
  <footer>Slide 01</footer>
</section>`
const REPEATED_DOC = `<main>${[0, 1]
  .map(
    (n) => `<article><p>The same lead appears before this title on every card.</p>
      <h2 id="repeated-${n}">Repeated title</h2>
      <p>The same supporting sentence follows this title on every card.</p></article>`,
  )
  .join("")}</main>`
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

// Three look-alike cards inside one authored node, with no markup of their own: they
// are movable because they repeat.
const AGENDA_DOC = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:sans-serif;margin:24px}.agenda{display:flex;gap:16px}
.agenda-item{flex:1 1 0;padding:18px;border-top:4px solid #0ca678}
</style></head><body>
<section data-derive-region="page" data-derive-layout="stack">
<h2 id="title" data-derive-node="title" data-derive-kind="heading">Agenda</h2>
<div id="main" data-derive-node="main" data-derive-kind="composition"><div class="agenda">
<div class="agenda-item" id="c1"><span class="index">01</span><h3 id="h1">Plan<br>the week</h3><p>First.</p></div>
<div class="agenda-item" id="c2"><span class="index">02</span><h3 id="h2">Ship<br>the work</h3><p>Second.</p></div>
<div class="agenda-item" id="c3"><span class="index">03</span><h3 id="h3">Review<br>the results</h3><p>Third.</p></div>
</div></div></section></body></html>`

// A long page, so a save has a scroll position to keep.
const PARAGRAPHS_DOC = `<style>body{font:16px/1.5 sans-serif;margin:24px;max-width:640px}.intro{height:1500px}</style>
<main>
<p class="intro">Scroll down to the crew notes.</p>
<h2 id="head">Crew notes</h2>
<p class="note">Night crews lift the old rail between the depot and the second stop, section by section. Day crews lay the new rail.</p>
<ul class="tasks"><li>Check the gauge</li></ul>
<p class="intro">The end of the notes.</p>
</main>`
const ROWS_DOC = `<style>body{font:16px/1.5 sans-serif;margin:96px 24px}table{border-collapse:collapse;width:360px}td{padding:6px 10px;border:1px solid #ccc}</style>
<table><tbody><tr><td>Survey</td><td>4</td></tr><tr><td>Rails</td><td>18</td></tr><tr><td>Overhead</td><td>9</td></tr></tbody></table>`

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

const frameSha = (page: Page) =>
  page.frameLocator("iframe[title]").locator("html").getAttribute("data-derive-src-sha")
/** Save, and wait until it landed. With `resume`, also wait for the session to pick
 *  back up on the reloaded page (an HTML save does), to keep editing there. */
async function saveEdits(page: Page, resume = false) {
  const sha = resume ? await frameSha(page) : null
  const response = page.waitForResponse(
    (r) => r.url().includes("/versions") && r.request().method() === "POST",
  )
  await page.getByTestId("inline-edit-save").click()
  expect((await response).ok()).toBe(true)
  if (!resume) return
  await expect.poll(() => frameSha(page).catch(() => sha), { timeout: 15_000 }).not.toBe(sha)
  await expect(page.getByTestId("inline-edit-bar")).toBeVisible()
}

/** The artifact's rendered document — a real cross-origin sandboxed iframe. */
const doc = (page: Page) => page.frameLocator("iframe[title]")

/** Pick a block up by its corner: around its words, not on them. */
const pickBlock = (page: Page, selector: string) =>
  doc(page)
    .locator(selector)
    .click({ position: { x: 4, y: 6 } })
/** Click at the end of an element's last line (its words, not its box) and type. */
async function typeAtLineEnd(page: Page, selector: string, text: string) {
  const el = doc(page).locator(selector)
  const box = await el.boundingBox()
  if (!box) throw new Error("not laid out")
  await el.click({ position: { x: box.width - 2, y: box.height - 4 } })
  await page.keyboard.press("End")
  await page.keyboard.type(text)
}
/** Arm a block with a click, then put the caret just before `before` in its words. */
async function caretBefore(page: Page, selector: string, before: string) {
  const el = doc(page).locator(selector)
  await el.click()
  await el.evaluate((node, text) => {
    const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      const i = (t.nodeValue ?? "").indexOf(text)
      if (i < 0) continue
      const range = document.createRange()
      range.setStart(t, i)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      return
    }
    throw new Error(`"${text}" is not in the block`)
  }, before)
}
/** The actions pill beside the selected block. */
const pill = (page: Page) => doc(page).locator(".derive-block-pill")
const order = (page: Page) =>
  doc(page)
    .locator(".agenda-item")
    .evaluateAll((els) => els.map((el) => el.id))

async function enterEditMode(page: Page) {
  await page.getByTestId("artifact-inline-edit").click()
  await expect(page.getByTestId("inline-edit-bar")).toBeVisible()
}

/** The keyboard way in. On a LaTeX artifact the header's Edit opens the source editor,
 *  so inline prose editing starts from `e` (or a selection) there. */
async function enterEditModeByKey(page: Page) {
  await page.keyboard.press("e")
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

  await saveEdits(owner)

  await expect(async () => {
    // The owner's own web publish is minutes old, so the inline save coalesces into
    // it: same version number, new bytes (a pause or a named version appends instead).
    expect(await versionOf(owner, shortId)).toBe(1)
    const html = await contentOf(owner, shortId)
    expect(html).toContain("First paragraph. Amended.")
    // Surgical: the rest of the source is untouched, markup included.
    expect(html).toContain("<p id=two>Second paragraph.</p>")
    expect(html).toContain("<h1>Runbook</h1>")
  }).toPass({ timeout: 10_000 })

  // Reopening shows the save. The version URL is unchanged, so this only holds if no
  // cache kept the pre-save bytes it served a moment ago.
  await owner.reload()
  await expect(doc(owner).locator("#one")).toHaveText("First paragraph. Amended.")
})

test("replaces deck text when its partial layout schema cannot be scanned", async ({ owner }) => {
  const shortId = await publishArtifact(
    owner,
    "partial-layout.deck.html",
    PARTIAL_LAYOUT_DOC,
    "text/html",
  )
  await openArtifact(owner, shortId)
  await enterEditMode(owner)

  const title = doc(owner).locator("#title")
  await title.click()
  await title.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await owner.keyboard.type("AI-native social")
  await appendToParagraph(owner, "subtitle", " Ready for review.")
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("2 unsaved changes")

  await saveEdits(owner)
  await expect(async () => {
    const saved = await contentOf(owner, shortId)
    expect(saved).toContain('<h1 id="title">AI-native social</h1>')
    expect(saved).toContain("The original supporting sentence. Ready for review.")
    expect(saved).toContain("<footer>Slide 01</footer>")
  }).toPass()
})

test("saves the selected occurrence when cards repeat the same wording", async ({ owner }) => {
  const shortId = await publishArtifact(owner, "repeated.html", REPEATED_DOC, "text/html")
  await openArtifact(owner, shortId)
  await enterEditMode(owner)

  const second = doc(owner).locator("#repeated-1")
  await second.click()
  await second.evaluate((el) => {
    ;(el as HTMLElement).focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await owner.keyboard.type("Updated title")
  await saveEdits(owner)
  await expect(async () => {
    const saved = await contentOf(owner, shortId)
    expect(saved).toContain('<h2 id="repeated-0">Repeated title</h2>')
    expect(saved).toContain('<h2 id="repeated-1">Updated title</h2>')
  }).toPass()
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

  await saveEdits(owner)
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

/**
 * A deck's own chrome, as real decks write it: invisible full-height prev/next
 * buttons laid over the slide (17% of the width each side), with the slide's title
 * and the start of every line underneath the left one.
 */
const ZONES_DOC = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0}.stage{position:relative;min-height:100vh}.slide{padding:40px 60px}
.zone{position:absolute;top:0;bottom:0;width:17%;border:0;background:none;cursor:pointer}
.zone.l{left:0}.zone.r{right:0}
</style></head><body><div class="stage"><section class="slide">
<h2 id="title">Agenda</h2>
<h3 id="card">Extensions and<br>Integration</h3>
<p id="item">Automations and workflows.</p>
<p id="other">A second paragraph.</p>
</section><button class="zone l" id="prev" aria-label="Previous slide"></button><button class="zone r" id="next" aria-label="Next slide"></button></div>
<script>for (const z of document.querySelectorAll('.zone')) z.onclick = () => { window.__nav = (window.__nav || 0) + 1 }</script>
</body></html>`

async function seedZones(page: Page) {
  const shortId = await publishArtifact(page, "zones.html", ZONES_DOC, "text/html")
  await openArtifact(page, shortId)
  await enterEditMode(page)
  return shortId
}

test("typing follows the click: a click off the active block takes the keyboard with it", async ({
  owner,
}) => {
  const shortId = await seedZones(owner)
  await appendToParagraph(owner, "item", " A")

  // The title sits under the deck's invisible "previous slide" button. The click
  // goes through it to the words, and the next keystroke lands there — not at the
  // end of the paragraph that was being edited a moment ago.
  await doc(owner)
    .locator("#title")
    .click({ position: { x: 10, y: 8 }, force: true })
  await owner.keyboard.type("B")
  await expect(doc(owner).locator("#item")).toHaveText("Automations and workflows. A")
  await expect(doc(owner).locator("#title")).toContainText("B")
  await expect(doc(owner).locator("#title")).toHaveText(/^[ABadegn]{7}$/)

  // Empty space under the other button arms nothing, so typing goes nowhere.
  const next = doc(owner).locator("#next")
  const box = await next.boundingBox()
  if (!box) throw new Error("zone not laid out")
  await next.click({ position: { x: 10, y: box.height - 10 }, force: true })
  await owner.keyboard.type("C")
  await expect(doc(owner).locator(".slide")).not.toContainText("C")
  // …and the deck's own handler never ran: editing never flips the slide.
  expect(
    await doc(owner)
      .locator("body")
      .evaluate(() => (window as unknown as { __nav?: number }).__nav ?? 0),
  ).toBe(0)

  // With the caret dropped, Escape asks about the mode rather than leaving silently.
  await owner.keyboard.press("Escape")
  await expect(owner.getByTestId("inline-edit-exit-confirm")).toBeVisible()
  await owner.getByTestId("confirm-dialog-cancel").click()
  await expect(owner.getByTestId("inline-edit-exit-confirm")).toBeHidden()

  await saveEdits(owner)
  // The success toast clears itself while the page is visible.
  const saved = owner.getByText(/^Saved v\d+$/)
  await expect(saved).toBeVisible()
  await expect(saved).toBeHidden({ timeout: 10_000 })
  const stored = await contentOf(owner, shortId)
  expect(stored).toContain('<p id="item">Automations and workflows. A</p>')
  expect(stored).toMatch(/<h2 id="title">[ABadegn]{7}<\/h2>/)
})

test("Shift+click through an overlay extends the selection, and Bold reaches it", async ({
  owner,
}) => {
  const shortId = await seedZones(owner)
  const item = doc(owner).locator("#item")
  // The paragraph's box runs past its words, so a click at its centre lands the caret
  // at the end; the Shift+click lands on its first letters, under the left button.
  await item.click()
  await item.click({ position: { x: 5, y: 8 }, force: true, modifiers: ["Shift"] })
  await owner.keyboard.press("ControlOrMeta+b")
  await saveEdits(owner)
  const stored = await contentOf(owner, shortId)
  expect(stored).toMatch(/<p id="item">A?<b>[^<]*workflows\.<\/b><\/p>/)
  expect(stored.replace(/<\/?b>/g, "")).toContain('<p id="item">Automations and workflows.</p>')
})

test("⌘A selects the block being edited, and a retype across a heading's <br> saves", async ({
  owner,
}) => {
  const shortId = await seedZones(owner)
  await doc(owner).locator("#other").click()
  await owner.keyboard.press("ControlOrMeta+a")
  await owner.keyboard.type("Replaced.")
  await expect(doc(owner).locator("#other")).toHaveText("Replaced.")
  await expect(doc(owner).locator("#item")).toHaveText("Automations and workflows.")

  // The heading's original <br> goes with the select-all; the server accepts a span
  // across it, so the retype saves as one line.
  await doc(owner).locator("#card").click()
  await owner.keyboard.press("ControlOrMeta+a")
  await owner.keyboard.type("Extensions & Integrations")
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("2 unsaved changes")

  await saveEdits(owner)
  const stored = await contentOf(owner, shortId)
  expect(stored).toContain('<p id="other">Replaced.</p>')
  expect(stored).toContain('<h3 id="card">Extensions &amp; Integrations</h3>')
  expect(stored).toContain('<p id="item">Automations and workflows.</p>')
})

test("closing the tab with unsaved inline edits asks first", async ({ owner }) => {
  await seed(owner)
  await enterEditMode(owner)
  await appendToParagraph(owner, "one", " Unsaved.")
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("1 unsaved change")
  const dialog = owner.waitForEvent("dialog")
  await owner.close({ runBeforeUnload: true })
  const prompt = await dialog
  expect(prompt.type()).toBe("beforeunload")
  await prompt.dismiss()
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
  await saveEdits(owner)

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
  const response = owner.waitForResponse(
    (r) => r.url().includes("/versions") && r.request().method() === "POST",
  )
  await owner.getByTestId("artifact-inspect-save").click()
  expect((await response).ok()).toBe(true)

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

  await saveEdits(owner)
  const src = await contentOf(owner, shortId)
  expect(src).toContain('style="display:block; width: 200px; height: auto"')
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
  // Around a card's words (not on them) picks the card up; its name leads the pill.
  await pickBlock(owner, "#card-a")
  await expect(pill(owner)).toContainText("Card 1")
  await frame.getByRole("button", { name: "Drag to move" }).dragTo(frame.locator("#card-b"))
  await expect(cards.nth(0)).toHaveAttribute("id", "card-b")
  await expect(cards.nth(1)).toHaveAttribute("id", "card-a")

  // Escape selects the board around it; its next move operates in the page region
  // and carries the already-reordered child region along unchanged.
  await owner.keyboard.press("Escape")
  await expect(frame.locator(".derive-block-box")).toHaveCSS("display", "block")
  await frame.getByRole("button", { name: "Move earlier" }).click()
  expect(
    await frame.locator("#board").evaluate((el) => el.parentElement?.firstElementChild === el),
  ).toBe(true)

  // Deleting a parent takes its child region with it; one shared Undo restores the
  // complete live subtree and both region-local moves remain representable.
  await frame.getByRole("button", { name: "Delete" }).click()
  await expect(frame.locator("#board")).toHaveCount(0)
  await owner.getByTestId("inline-edit-undo").click()
  await expect(frame.locator("#board")).toHaveCount(1)
  await expect(cards.nth(0)).toHaveAttribute("id", "card-b")

  await saveEdits(owner, true)
  const saved = await contentOf(owner, shortId)
  expect(saved.indexOf('data-derive-node="board"')).toBeLessThan(
    saved.indexOf('data-derive-node="title"'),
  )
  expect(saved.indexOf('data-derive-node="move"')).toBeLessThan(
    saved.indexOf('data-derive-node="discover"'),
  )
  expect(saved).toContain('data-derive-owner="board"')

  // The session picks back up on the saved page. Discard walks a new move back
  // without publishing, and keeps the mode open; Done is the way out.
  await pickBlock(owner, "#card-b")
  await owner.keyboard.press("Alt+ArrowRight")
  await expect(cards.nth(0)).toHaveAttribute("id", "card-a")
  await owner.getByTestId("inline-edit-discard").click()
  await expect(cards.nth(0)).toHaveAttribute("id", "card-b")
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("click text to edit")
  await owner.getByTestId("inline-edit-done").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()

  // If the final intent removes the parent, child-region changes are superseded by
  // that atomic subtree removal instead of producing a dangling operation.
  await enterEditMode(owner)
  await pickBlock(owner, "#card-b")
  await owner.keyboard.press("Alt+ArrowRight")
  await owner.keyboard.press("Escape")
  await owner.keyboard.press("Delete")
  await saveEdits(owner)
  expect(await contentOf(owner, shortId)).not.toContain('data-derive-node="board"')
})

test("words take a caret, even in a node; around them picks the block; Escape walks out", async ({
  owner,
}) => {
  const shortId = await publishArtifact(owner, "agenda.html", AGENDA_DOC, "text/html")
  await openArtifact(owner, shortId)
  await enterEditMode(owner)
  const frame = doc(owner)

  // One click on a card's words types there: no box selection from text.
  await typeAtLineEnd(owner, "#h2", " now")
  await expect(frame.locator("#h2")).toContainText("the work now")
  await expect(pill(owner)).toBeHidden()

  // Escape: the caret gives way to its card, the card to the node around it, then
  // to nothing. The pill names each level and follows the layout (a row: ← →).
  await owner.keyboard.press("Escape")
  await expect(pill(owner)).toBeVisible()
  await expect(pill(owner).getByRole("button", { name: "Drag to move" })).toHaveText("⠿Card 2")
  await expect(pill(owner).getByRole("button", { name: "Move earlier" })).toHaveText("←")
  await owner.keyboard.press("Escape")
  await expect(pill(owner).getByRole("button", { name: "Drag to move" })).toHaveText("⠿Section")
  await owner.keyboard.press("Escape")
  await expect(pill(owner)).toBeHidden()

  // Hover names a block before any click; its tag selects it.
  await frame.locator("#c3").hover({ position: { x: 6, y: 8 } })
  await expect(frame.locator(".derive-block-tag")).toHaveText("⠿ Card 3")
  await frame.locator(".derive-block-tag").click()
  await expect(pill(owner).getByRole("button", { name: "Drag to move" })).toHaveText("⠿Card 3")
  await expect(pill(owner).getByRole("button", { name: "Move later" })).toBeDisabled()

  // Three clicks take the whole heading, across its line break.
  await frame.locator("#h1").click({ clickCount: 3 })
  await owner.keyboard.type("Plan ahead")
  await expect(frame.locator("#h1")).toHaveText("Plan ahead")

  await saveEdits(owner)
  await expect(async () => {
    const saved = await contentOf(owner, shortId)
    expect(saved).toContain('<h3 id="h1">Plan ahead</h3>')
    expect(saved).toContain('<h3 id="h2">Ship<br>the work now</h3>')
  }).toPass({ timeout: 10_000 })
})

test("repeated cards move without author markup: drag, ⌥ arrows, duplicate and delete", async ({
  owner,
}) => {
  const shortId = await publishArtifact(owner, "agenda.html", AGENDA_DOC, "text/html")
  await openArtifact(owner, shortId)
  await enterEditMode(owner)
  const frame = doc(owner)

  await pickBlock(owner, "#c1")
  await expect(pill(owner).getByRole("button", { name: "Move earlier" })).toBeDisabled()
  await owner.keyboard.press("Alt+ArrowRight")
  await expect.poll(() => order(owner)).toEqual(["c2", "c1", "c3"])

  // The pill's name is the drag handle; siblings reflow along the row as it moves.
  const handle = pill(owner).getByRole("button", { name: "Drag to move" })
  const from = await handle.boundingBox()
  const to = await frame.locator("#c3").boundingBox()
  if (!from || !to) throw new Error("not laid out")
  await owner.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await owner.mouse.down()
  await owner.mouse.move(to.x + to.width * 0.9, to.y + to.height / 2, { steps: 8 })
  await owner.mouse.up()
  await expect.poll(() => order(owner)).toEqual(["c2", "c3", "c1"])

  // ⌘D copies the selected card after itself and selects the copy; Delete removes it.
  await owner.keyboard.press("ControlOrMeta+d")
  await expect(frame.locator(".agenda-item")).toHaveCount(4)
  await owner.keyboard.press("Delete")
  await expect(frame.locator(".agenda-item")).toHaveCount(3)
  await pickBlock(owner, "#c3")
  await pill(owner).getByRole("button", { name: "Duplicate" }).click()
  await expect(frame.locator(".agenda-item")).toHaveCount(4)

  await saveEdits(owner)
  await expect(async () => {
    const saved = await contentOf(owner, shortId)
    // The copy keeps its source's bytes but not its id: ids stay unique.
    const ids = [...saved.matchAll(/<div class="agenda-item" id="(c\d)([^"]*)">/g)]
    expect(ids.map((m) => m[1])).toEqual(["c2", "c3", "c3", "c1"])
    expect(new Set(ids.map((m) => m[0])).size).toBe(4)
    expect(saved).not.toContain("derive-block")
  }).toPass({ timeout: 10_000 })
})

test("the changes list says where and what changed, shows it, and reverts just one", async ({
  owner,
}) => {
  const shortId = await publishArtifact(owner, "agenda.html", AGENDA_DOC, "text/html")
  await openArtifact(owner, shortId)
  await enterEditMode(owner)
  const frame = doc(owner)

  await typeAtLineEnd(owner, "#h2", " now")
  await pickBlock(owner, "#c1")
  await owner.keyboard.press("Alt+ArrowRight")
  await expect.poll(() => order(owner)).toEqual(["c2", "c1", "c3"])

  await owner.getByTestId("inline-edit-changes").click()
  const rows = owner.getByTestId("inline-edit-change")
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText("Section")
  await expect(rows.nth(0)).toContainText("Moved Plan the week from 1 → 2")
  await expect(rows.nth(1)).toContainText("Card 1 · Heading")
  await expect(rows.nth(1)).toContainText("Ship the work → Ship the work now")

  // A row shows its element in the document.
  await rows.nth(1).click()
  await expect(frame.locator("#h2")).toHaveClass(/derive-block-flash/)

  // ↺ puts back only that change: the words return, the move stays.
  await owner.getByTestId("inline-edit-change-revert").nth(1).click()
  await expect(frame.locator("#h2")).not.toContainText("now")
  await expect(owner.getByTestId("inline-edit-changes")).toHaveText(/^1 unsaved change/)
  await expect.poll(() => order(owner)).toEqual(["c2", "c1", "c3"])

  await saveEdits(owner)
  await expect(async () => {
    const saved = await contentOf(owner, shortId)
    expect(saved.indexOf('id="c2"')).toBeLessThan(saved.indexOf('id="c1"'))
    expect(saved).toContain('<h3 id="h2">Ship<br>the work</h3>')
  }).toPass({ timeout: 10_000 })
})

test("Enter starts a new paragraph of the same kind, Shift+Enter breaks the line, a save keeps your place", async ({
  owner,
}) => {
  const shortId = await publishArtifact(owner, "notes.html", PARAGRAPHS_DOC, "text/html")
  await openArtifact(owner, shortId)
  await enterEditMode(owner)
  const frame = doc(owner)
  const notes = frame.locator("p.note")

  // Enter splits the paragraph at the caret; the second half is the same element.
  await caretBefore(owner, "p.note", " Day crews")
  await owner.keyboard.press("Enter")
  await expect(notes).toHaveCount(2)
  await expect(notes.nth(1)).toHaveText(" Day crews lay the new rail.")
  // Backspace at its start makes them one paragraph again; Enter splits them again.
  await owner.keyboard.press("Backspace")
  await expect(notes).toHaveCount(1)
  await owner.keyboard.press("Enter")
  await expect(notes).toHaveCount(2)
  // Enter at the end of the last one leaves an empty paragraph, a line of its own.
  await typeAtLineEnd(owner, "p.note >> nth=1", "")
  await owner.keyboard.press("Enter")
  await expect(notes).toHaveCount(3)

  // A change far into a long paragraph is listed where it happened.
  await typeAtLineEnd(owner, "p.note >> nth=0", " Slowly.")
  await owner.getByTestId("inline-edit-changes").click()
  await expect(owner.getByTestId("inline-edit-changes-list")).toContainText("section. Slowly.")
  await owner.getByTestId("inline-edit-changes").click()

  // In a list: Shift+Enter breaks the line inside the item, Enter starts the next item.
  await typeAtLineEnd(owner, "ul.tasks li", "")
  await owner.keyboard.press("Shift+Enter")
  await owner.keyboard.type("and level")
  await owner.keyboard.press("Enter")
  await owner.keyboard.type("Sweep the bed")
  await expect(frame.locator("ul.tasks li")).toHaveCount(2)

  // A heading doesn't split: Enter at its end goes on to the words after it.
  await typeAtLineEnd(owner, "#head", "")
  await owner.keyboard.press("Enter")
  await owner.keyboard.type("Tonight: ")
  await expect(frame.locator("h2")).toHaveCount(1)
  await expect(notes.nth(0)).toHaveText(/^Tonight: Night crews/)

  const scrollY = () => frame.locator("body").evaluate(() => window.scrollY)
  // Where the reader is, once the page has finished bringing the words into view.
  let was = -1
  await expect
    .poll(
      async () => {
        const now = await scrollY()
        const settled = now === was
        was = now
        return settled
      },
      { intervals: [300] },
    )
    .toBe(true)
  expect(was).toBeGreaterThan(500)
  await saveEdits(owner, true)
  // The saved page opens where the reader was, and this save isn't someone else's news.
  await expect.poll(async () => Math.abs((await scrollY()) - was)).toBeLessThan(3)
  await expect(owner.getByText(/was just published/)).toHaveCount(0)
  const saved = await contentOf(owner, shortId)
  expect(saved).toContain(
    '<p class="note">Tonight: Night crews lift the old rail between the depot and the second stop, section by section. Slowly.</p>\n<p class="note"> Day crews lay the new rail.</p>\n<p class="note"><br></p>\n<ul class="tasks"><li>Check the gauge<br>and level</li><li>Sweep the bed</li></ul>',
  )
  expect(saved).not.toContain("data-derive")
})

test("the block pill stays off the neighbouring rows and never keeps the keyboard", async ({
  owner,
}) => {
  const shortId = await publishArtifact(owner, "rows.html", ROWS_DOC, "text/html")
  await openArtifact(owner, shortId)
  await enterEditMode(owner)
  const frame = doc(owner)
  const rows = frame.locator("tr")

  // Escape steps out of the words to the row around them.
  await frame.getByText("Rails").click()
  await owner.keyboard.press("Escape")
  const name = pill(owner).getByRole("button", { name: "Drag to move" })
  await expect(name).toHaveText("⠿Row 2")
  const box = await pill(owner).boundingBox()
  if (!box) throw new Error("not laid out")
  for (const i of [0, 2]) {
    const row = await rows.nth(i).boundingBox()
    if (!row) throw new Error("not laid out")
    const apart =
      box.x >= row.x + row.width ||
      row.x >= box.x + box.width ||
      box.y >= row.y + row.height ||
      row.y >= box.y + box.height
    expect(apart, `the pill covers row ${i + 1}`).toBe(true)
  }

  // A pill button acts once: the keyboard stays with the document, so Space typed
  // next presses nothing.
  await pill(owner).getByRole("button", { name: "Duplicate" }).click()
  await expect(rows).toHaveCount(4)
  await owner.keyboard.press(" ")
  await expect(rows).toHaveCount(4)
  expect(await frame.locator("body").evaluate(() => document.activeElement?.localName)).not.toBe(
    "button",
  )

  // With a block selected, a click on words still puts the caret there.
  await typeAtLineEnd(owner, "tr >> nth=0 >> td >> nth=0", "!")
  await expect(frame.locator("td").first()).toHaveText("Survey!")
  await expect(pill(owner)).toBeHidden()

  await saveEdits(owner)
  await expect(async () => {
    const saved = await contentOf(owner, shortId)
    expect(saved.match(/<td>Rails<\/td>/g)).toHaveLength(2)
    expect(saved).toContain("<td>Survey!</td>")
  }).toPass({ timeout: 10_000 })
})

// A copy shares its original's source id; what is typed into one must never be
// saved as the other's words.
const COPIES_DOC = `<style>body{font:16px/1.5 sans-serif;margin:96px 24px}td{padding:6px 10px;border:1px solid #ccc}.card{padding:12px;margin:8px 0;border:1px solid #ccc}</style>
<table><tbody><tr><td>Survey</td><td>4</td></tr><tr><td>Rails</td><td>18</td></tr></tbody></table>
<ul class="tasks"><li>Check the gauge</li><li>Sweep the bed</li></ul>
<ol class="steps"><li>Lift the rail</li><li>Lay the rail</li></ol>
<div class="cards"><div class="card"><h3>Plan</h3><p>First.</p></div><div class="card"><h3>Ship</h3><p>Second.</p></div></div>`

test("a duplicate and its original each save their own words", async ({ owner }) => {
  const shortId = await publishArtifact(owner, "copies.html", COPIES_DOC, "text/html")
  await openArtifact(owner, shortId)
  await enterEditMode(owner)
  const frame = doc(owner)
  const duplicate = async () => {
    await pill(owner).getByRole("button", { name: "Duplicate" }).click()
  }

  // A row: only the copy is edited.
  await frame.getByText("Rails").click()
  await owner.keyboard.press("Escape")
  await duplicate()
  await expect(frame.locator("tr")).toHaveCount(3)
  await typeAtLineEnd(owner, "tr >> nth=2 >> td >> nth=0", " copy")
  await expect(frame.locator("tr").nth(2)).toContainText("Rails copy")

  // A list item: only the original is edited, after the copy is made.
  await frame.getByText("Check the gauge").click()
  await owner.keyboard.press("Escape")
  await duplicate()
  await expect(frame.locator("ul.tasks li")).toHaveCount(3)
  await typeAtLineEnd(owner, "ul.tasks li >> nth=0", " first")
  await expect(frame.locator("ul.tasks li").nth(1)).toHaveText("Check the gauge")

  // A list item edited, then copied: the copy carries the words it shows.
  await typeAtLineEnd(owner, "ol.steps li >> nth=0", " again")
  await owner.keyboard.press("Escape")
  await duplicate()
  await expect(frame.locator("ol.steps li")).toHaveText([
    "Lift the rail again",
    "Lift the rail again",
    "Lay the rail",
  ])

  // A card: both it and its copy are edited, differently.
  await pickBlock(owner, ".card >> nth=1")
  await duplicate()
  await expect(frame.locator(".card")).toHaveCount(3)
  await typeAtLineEnd(owner, ".card >> nth=1 >> p", " A")
  await typeAtLineEnd(owner, ".card >> nth=2 >> p", " B")
  await expect(frame.locator(".card p")).toHaveText(["First.", "Second. A", "Second. B"])

  await saveEdits(owner)
  await expect(async () => {
    const saved = await contentOf(owner, shortId)
    expect(saved).toContain(
      "<tr><td>Rails</td><td>18</td></tr><tr><td>Rails copy</td><td>18</td></tr>",
    )
    expect(saved).toContain(
      '<ul class="tasks"><li>Check the gauge first</li><li>Check the gauge</li><li>Sweep the bed</li></ul>',
    )
    expect(saved).toContain(
      '<ol class="steps"><li>Lift the rail again</li><li>Lift the rail again</li><li>Lay the rail</li></ol>',
    )
    expect(saved).toContain(
      '<div class="card"><h3>Ship</h3><p>Second. A</p></div><div class="card"><h3>Ship</h3><p>Second. B</p></div>',
    )
    expect(saved).not.toContain("data-derive")
  }).toPass({ timeout: 10_000 })
})

test("the second half of an Enter split saves what is typed into it later", async ({ owner }) => {
  const shortId = await publishArtifact(owner, "split.html", PARAGRAPHS_DOC, "text/html")
  await openArtifact(owner, shortId)
  await enterEditMode(owner)
  const notes = doc(owner).locator("p.note")

  await caretBefore(owner, "p.note", " Day crews")
  await owner.keyboard.press("Enter")
  await expect(notes).toHaveCount(2)
  // Somewhere else first, then back into the second half.
  await typeAtLineEnd(owner, "#head", " tonight")
  await typeAtLineEnd(owner, "p.note >> nth=1", " Quickly.")
  await expect(notes.nth(1)).toHaveText(" Day crews lay the new rail. Quickly.")

  await saveEdits(owner)
  await expect(async () => {
    const saved = await contentOf(owner, shortId)
    expect(saved).toContain(
      '<p class="note">Night crews lift the old rail between the depot and the second stop, section by section.</p>\n<p class="note"> Day crews lay the new rail. Quickly.</p>',
    )
    expect(saved).toContain('<h2 id="head">Crew notes tonight</h2>')
  }).toPass({ timeout: 10_000 })
})

test("resize from the edge or corner with a readout; double-click resets; ⋯ sets it exactly", async ({
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
  const frame = doc(owner)
  const edge = frame.getByRole("button", { name: "Resize width (double-click for auto)" })
  const corner = frame.getByRole("button", {
    name: "Resize width and height (double-click for auto)",
  })

  // Only a layout a save can honour offers handles; every other node just moves.
  for (const selector of [
    "#reverse-a",
    "#grid-a",
    "#wrapped-a",
    "#absolute-a",
    "#overlap-a",
    "#columns-a",
  ]) {
    await pickBlock(owner, selector)
    await expect(pill(owner)).toBeVisible()
    await expect(edge).toBeHidden()
  }

  const safe = frame.locator("#safe-a")
  await pickBlock(owner, "#safe-a")
  await expect(edge).toBeVisible()
  await expect(corner).toBeVisible()
  const grip = await edge.boundingBox()
  const region = await frame.locator("#safe-region").boundingBox()
  if (!grip || !region) throw new Error("not laid out")
  await owner.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await owner.mouse.down()
  await owner.mouse.move(grip.x + grip.width / 2 + region.width * 0.12, grip.y + grip.height / 2)
  // The readout speaks while the handle moves; the pill steps aside.
  await expect(frame.locator(".derive-block-size")).toHaveText("62% wide")
  await expect(pill(owner)).toBeHidden()
  await owner.mouse.up()
  await expect(safe).toHaveAttribute("data-derive-width", "62")

  // Double-click puts the width back to auto.
  await edge.dblclick()
  await expect(safe).not.toHaveAttribute("data-derive-width")

  // ⋯ opens the edit panel on the block: its path, and an exact width.
  await pill(owner).getByRole("button", { name: "More options" }).click()
  const panel = owner.getByTestId("artifact-inspect-block")
  await expect(panel).toBeVisible()
  await expect(owner.getByTestId("artifact-inspect-crumb-0")).toHaveText("Card 1")
  await owner.getByTestId("artifact-inspect-block-width").fill("70")
  await owner.getByTestId("artifact-inspect-block-width").press("Enter")
  await expect(safe).toHaveAttribute("data-derive-width", "70")
  await owner.getByTestId("artifact-inspect-block-auto").click()
  await expect(safe).not.toHaveAttribute("data-derive-width")
  await owner.getByTestId("artifact-inspect-block-width").fill("64")
  await owner.getByTestId("artifact-inspect-block-width").press("Enter")
  await expect(safe).toHaveAttribute("data-derive-width", "64")

  await saveEdits(owner)
  await expect(async () => {
    const opening = (await contentOf(owner, shortId)).match(/<article id="safe-a"[^>]*>/)?.[0]
    expect(opening).toContain('data-derive-width="64"')
    expect(opening).toContain("--derive-structural-width: 64%")
  }).toPass({ timeout: 10_000 })
})

test("a resize the layout can't honour, or one cut short, leaves the block as it was", async ({
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
  const corner = frame.getByRole("button", {
    name: "Resize width and height (double-click for auto)",
  })

  // Growing a child inside a fixed-height, clipping owner would clip it: refused.
  const child = frame.locator("#css-child")
  await pickBlock(owner, "#css-child")
  const grip = await corner.boundingBox()
  if (!grip) throw new Error("not laid out")
  await owner.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await owner.mouse.down()
  await owner.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 160, { steps: 4 })
  await owner.mouse.up()
  await expect(child).toHaveAttribute("data-derive-height", "60")
  await expect(owner.getByText("The page's own layout decides that")).toBeVisible()

  // ⌘S mid-drag ends the drag rather than saving a half-made size.
  await owner.keyboard.press("Escape")
  await owner.keyboard.press("Escape")
  await expect(pill(owner)).toBeHidden()
  const guarded = frame.locator("#guarded")
  await pickBlock(owner, "#guarded")
  const edge = frame.getByRole("button", { name: "Resize width (double-click for auto)" })
  const e = await edge.boundingBox()
  if (!e) throw new Error("not laid out")
  await owner.mouse.move(e.x + e.width / 2, e.y + e.height / 2)
  await owner.mouse.down()
  await owner.mouse.move(e.x + e.width / 2 - 60, e.y + e.height / 2)
  await owner.keyboard.press("ControlOrMeta+s")
  await owner.mouse.up()
  await expect(guarded).toHaveAttribute("data-derive-width", "50")
  expect(await versionOf(owner, shortId)).toBe(1)
  await expect(owner.getByTestId("inline-edit-changes")).toBeHidden()
})

test("responsive edit previews use the real iframe viewport", async ({ owner }) => {
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

  // Blocks stay pickable at the preview width: the pill fits inside the frame.
  await pickBlock(owner, "#alpha")
  await expect(pill(owner)).toBeInViewport({ ratio: 1 })

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
  await saveEdits(owner)

  await expect(async () => {
    const stored = await contentOf(owner, shortId)
    expect(stored).toContain("**San Francisco · Full-time · In person**")
    expect(stored).not.toContain("$150,000")
  }).toPass({ timeout: 10_000 })
})

test("Markdown saves a retyped list item whose bold runs into its full stop", async ({ owner }) => {
  // The whole-item span has to read the item the way the stored text does: nothing
  // between "bed" and "." where the bold closes.
  const markdown = "# Crews\n\n- Sweep the **track bed**.\n- Log the weak joints.\n"
  const shortId = await publishArtifact(owner, "crews.md", markdown, "text/markdown")
  await openArtifact(owner, shortId)
  await enterEditMode(owner)

  await doc(owner).locator("li").first().click({ clickCount: 3 })
  await owner.keyboard.type("Sweep the yard.")
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("1 unsaved change")
  await saveEdits(owner)
  await expect(async () => {
    const stored = await contentOf(owner, shortId)
    expect(stored).toContain("- Sweep the yard.\n- Log the weak joints.\n")
  }).toPass({ timeout: 10_000 })
})

test("Markdown saves exactly: typed Markdown is source, code takes a caret, Shift+Enter breaks the line", async ({
  owner,
}) => {
  const markdown = "# Notes\n\nThe *first* step &mdash; see `v1` today.\n\n- One\n- Two\n"
  const shortId = await publishArtifact(owner, "notes.md", markdown, "text/markdown")
  await openArtifact(owner, shortId)
  await enterEditMode(owner)

  // Markdown is source: typed `**now**` is saved as written, and reads as bold.
  await typeAtLineEnd(owner, "p", " **now**")
  // Inside a code span the words take a caret like any other.
  await doc(owner)
    .locator("p code")
    .evaluate((el) => {
      const text = el.firstChild as Text
      const range = document.createRange()
      range.setStart(text, text.length)
      range.collapse(true)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
    })
  await owner.keyboard.type("2")
  // Shift+Enter in a list item: a hard break, the next line under the item's indent.
  await typeAtLineEnd(owner, "li >> nth=1", "")
  await owner.keyboard.press("ArrowLeft")
  await owner.keyboard.press("Shift+Enter")
  await saveEdits(owner, true)
  // Every byte the edits didn't touch is as it was: the entity, the markers, the blank lines.
  expect(await contentOf(owner, shortId)).toBe(
    "# Notes\n\nThe *first* step &mdash; see `v12` today. **now**\n\n- One\n- Tw\\\n  o\n",
  )
  await expect(doc(owner).locator("p strong")).toHaveText("now")

  // The session picked back up on the saved page: the next edit saves the same way.
  await typeAtLineEnd(owner, "h1", " B")
  await saveEdits(owner, true)
  expect(await contentOf(owner, shortId)).toBe(
    "# Notes B\n\nThe *first* step &mdash; see `v12` today. **now**\n\n- One\n- Tw\\\n  o\n",
  )
})

test("Markdown Enter starts a new paragraph or item, Shift+Enter breaks the line, and both save exactly", async ({
  owner,
}) => {
  const markdown =
    "# Crew notes\n\nNight crews lift the old rail. Day crews lay the new rail.\n\n* Check the gauge\n* Sweep the bed\n\n| Task | Crew |\n| --- | --- |\n| Lift | Night |\n"
  const shortId = await publishArtifact(owner, "crew.md", markdown, "text/markdown")
  await openArtifact(owner, shortId)
  await enterEditMode(owner)
  const frame = doc(owner)
  const paras = frame.locator("main > p")
  const items = frame.locator("li")

  // Enter splits the paragraph at the caret; Backspace at the new one's start joins it back.
  await caretBefore(owner, "main > p", "Day crews")
  await owner.keyboard.press("Enter")
  await expect(paras).toHaveCount(2)
  await expect(paras.nth(1)).toHaveText("Day crews lay the new rail.")
  await owner.keyboard.press("Backspace")
  await expect(paras).toHaveCount(1)
  await owner.keyboard.press("Enter")
  await expect(paras).toHaveCount(2)
  // Shift+Enter is a hard break inside the paragraph.
  await typeAtLineEnd(owner, "main > p >> nth=1", "")
  await owner.keyboard.press("Shift+Enter")
  await owner.keyboard.type("By noon.")
  // Enter in a list item starts the next item.
  await typeAtLineEnd(owner, "li >> nth=0", "")
  await owner.keyboard.press("Enter")
  await owner.keyboard.type("Level the rail")
  await expect(items).toHaveCount(3)
  // A table cell is one line: Enter breaks it.
  await typeAtLineEnd(owner, "td >> nth=0", "")
  await owner.keyboard.press("Enter")
  await owner.keyboard.type("and tamp")
  await expect(frame.locator("tr")).toHaveCount(2)

  await saveEdits(owner, true)
  // A blank line between the halves, the item's own marker, a hard break, a <br> in the
  // cell; every other byte as it was.
  expect(await contentOf(owner, shortId)).toBe(
    "# Crew notes\n\nNight crews lift the old rail. \n\nDay crews lay the new rail.\\\nBy noon.\n\n* Check the gauge\n* Level the rail\n* Sweep the bed\n\n| Task | Crew |\n| --- | --- |\n| Lift<br>and tamp | Night |\n",
  )
  await expect(paras).toHaveCount(2)
  await expect(items).toHaveCount(3)

  // The session picked back up on the saved page, and splits again the same way.
  await typeAtLineEnd(owner, "li >> nth=2", "")
  await owner.keyboard.press("Enter")
  await owner.keyboard.type("Oil the points")
  await typeAtLineEnd(owner, "main > p >> nth=0", "")
  await owner.keyboard.press("Enter")
  await owner.keyboard.type("Then:")
  await saveEdits(owner, true)
  expect(await contentOf(owner, shortId)).toBe(
    "# Crew notes\n\nNight crews lift the old rail.\n\nThen: \n\nDay crews lay the new rail.\\\nBy noon.\n\n* Check the gauge\n* Level the rail\n* Sweep the bed\n* Oil the points\n\n| Task | Crew |\n| --- | --- |\n| Lift<br>and tamp | Night |\n",
  )
})

test("replacing selected linked and annotated text saves the user's replacement", async ({
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
    ;(el as HTMLElement).focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await owner.keyboard.type("Rewritten content")
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("1 unsaved change")
  await saveEdits(owner)
  await expect(async () => {
    expect(await contentOf(owner, shortId)).toBe('<p class="target">Rewritten content</p>')
  }).toPass()
})

test("formats a selection that starts inside a link and crosses an annotation", async ({
  owner,
}) => {
  const html =
    '<p class="target"><a href="/jobs">Alpha</a> <mark data-note="keep">Beta</mark> Gamma</p>'
  const shortId = await publishArtifact(owner, "format-linked.html", html, "text/html")
  await openArtifact(owner, shortId)
  await enterEditMode(owner)

  const target = doc(owner).locator(".target")
  await target.click()
  await target.evaluate((el) => {
    ;(el as HTMLElement).focus()
    const start = el.querySelector("a")?.firstChild
    const end = el.lastChild
    if (!start || !end) throw new Error("Expected inline text nodes")
    const range = document.createRange()
    range.setStart(start, 2)
    range.setEnd(end, 4)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await expect(owner.getByTestId("inline-edit-bold")).toBeEnabled()
  await owner.getByTestId("inline-edit-bold").click()
  await saveEdits(owner)
  await expect(async () => {
    const saved = await contentOf(owner, shortId)
    // What the page shows is what's saved: the bold run keeps the link's second half
    // (a copy of the authored link) and the annotation, byte for byte.
    expect(saved).toBe(
      '<p class="target"><a href="/jobs">Al</a><b><a href="/jobs">pha</a> <mark data-note="keep">Beta</mark> Gam</b>ma</p>',
    )
  }).toPass()
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
  await enterEditModeByKey(owner)
  // Click the first word, not the centre of the line (that could be the formula).
  await p.click({ position: { x: 6, y: 8 } })
  await owner.keyboard.press("End")
  await owner.keyboard.type(" Amended.")
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("1 unsaved change")
  await saveEdits(owner)
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
  await enterEditModeByKey(owner)
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
  await saveEdits(owner)
  await expect(async () => {
    expect(await contentOf(owner, shortId)).toContain("\\caption{A caption to edit. More.}")
  }).toPass()
})

test("LaTeX: Backspace right after a formula cannot swallow it", async ({ owner }) => {
  const shortId = await seedTex(owner)
  const p = paper(owner).locator("p").first()
  await expect(p.locator(".katex").first()).toBeVisible()
  await enterEditModeByKey(owner)
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
  // On a paper the header's Edit is the source editor (a paper is written in its
  // source); inline editing of the prose starts from `e`.
  await owner.getByTestId("artifact-inline-edit").click()
  await expect(owner.locator(".cm-content")).toBeVisible()
  await expect(owner.getByTestId("artifact-publish-version")).toHaveText("Save")
  await owner.getByTestId("artifact-edit-cancel").click()
  await expect(owner.locator(".cm-content")).toBeHidden()
  await enterEditModeByKey(owner)
  const p = paper(owner).locator("p").first()
  await p.click({ position: { x: 6, y: 8 } })
  await owner.keyboard.press("End")
  await owner.keyboard.type(" Amended.")
  await saveEdits(owner)
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
