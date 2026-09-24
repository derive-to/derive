import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { sourceElements } from "@derive/core"
import type { Page } from "@playwright/test"
import { expect, openArtifact, publishArtifact, test } from "../fixtures"

// Browser half of the editing corpus for structural regions and frame focus. The core
// lane pins the source contract; these pin what the live frame offers on real markup.

/** A real 44-slide deck with placeholder copy (see packages/core/test/fixtures/decks). */
const REAL_DECK = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../packages/core/test/fixtures/decks/structural-deck-44.html",
  ),
  "utf8",
)

const frame = (page: Page) => page.frameLocator("iframe[title]")

const contentOf = async (page: Page, shortId: string): Promise<string> => {
  const response = await page.request.get(`/v1/artifacts/${shortId}/content`)
  expect(response.ok(), `content fetch failed: ${response.status()}`).toBeTruthy()
  return response.text()
}

/** The fixture has no navigation script; flip the visible slide the way its own would. */
const showSlide = (page: Page, position: number) =>
  frame(page)
    .locator("body")
    .evaluate((_, index) => {
      for (const [i, slide] of Array.from(document.querySelectorAll(".slide")).entries())
        slide.classList.toggle("on", i === index)
    }, position - 1)

/** The stored bytes of each slide section, in order. */
const slidesOf = (html: string) => html.match(/<section class="slide[\s\S]*?<\/section>/g) ?? []

/** Save, and return what the browser sent: an exact-source save carries `ops`. */
const saveOps = async (page: Page) => {
  const request = page.waitForRequest((r) => r.method() === "POST" && r.url().includes("/versions"))
  await page.getByTestId("inline-edit-save").click()
  const body = (await request).postData() ?? ""
  await expect(page.getByTestId("inline-edit-bar")).toBeHidden()
  const ops = body.match(/name="ops"\r\n\r\n([\s\S]*?)\r\n--/)?.[1]
  expect(ops, "the save was sent as exact-source ops").toBeTruthy()
  return JSON.parse(ops as string) as { op: string; src: number }[]
}

const openDeckEditor = async (page: Page) => {
  const shortId = await publishArtifact(page, "deck.html", REAL_DECK, "text/html")
  await openArtifact(page, shortId)
  await expect(page.getByTestId("deck-position")).toBeVisible()
  await page.getByTestId("deck-edit").click()
  await expect(page.getByTestId("inline-edit-bar")).toBeVisible()
  return shortId
}
const selectNode = (page: Page, id: string) =>
  frame(page)
    .locator(`[data-derive-node='${id}']`)
    .click({ position: { x: 4, y: 4 } })

/** Swap two distinct byte runs of `html` (each present once). */
const swap = (html: string, a: string, b: string) =>
  html.replace(a, "\u0000").replace(b, a).replace("\u0000", b)
/** A node's exact source bytes in the fixture. */
const nodeBytes = (id: string) => {
  const el = sourceElements(REAL_DECK).find((e) =>
    REAL_DECK.slice(e.tag.start, e.tag.end).includes(`data-derive-node="${id}"`),
  )
  return el ? REAL_DECK.slice(el.tag.start, el.end) : ""
}

test("[BROWSER-DECK-STRUCT-001] a real deck arranges every slide; what sits around the nodes stays put", async ({
  owner,
}) => {
  const shortId = await openDeckEditor(owner)
  const doc = frame(owner)

  // Every node directly under its region is armed (tabindex is the frame's
  // availability mark), whatever else the slide carries.
  await expect(doc.locator("[data-derive-region='slide-0'] > [data-derive-node]")).toHaveCount(2)
  await expect
    .poll(() =>
      doc.locator("body").evaluate(() =>
        Array.from(document.querySelectorAll("[data-derive-region] > [data-derive-node]"))
          .filter((node) => !node.hasAttribute("tabindex"))
          .map((node) => node.getAttribute("data-derive-node")),
      ),
    )
    .toEqual([])

  // Slide 1 ends with a footer, a number, and notes: its nodes swap places and the
  // un-owned tail stays last.
  await selectNode(owner, "s0-main")
  await doc.getByRole("button", { name: "Move earlier (Option+Up)" }).click()
  await expect
    .poll(() =>
      doc
        .locator("[data-derive-region='slide-0']")
        .evaluate((region) => Array.from(region.children).map((child) => child.className)),
    )
    .toEqual(["body", "brandrow", "foot", "num", "notes"])

  // Slide 19 has a subtitle between two nodes: the nodes swap around it.
  await showSlide(owner, 19)
  await selectNode(owner, "s15-title")
  await doc.getByRole("button", { name: "Move later (Option+Down)" }).click()

  const ops = await saveOps(owner)
  expect(ops.map((op) => op.op)).toEqual(["content", "content"])
  // Byte for byte: each move swaps two nodes' bytes and nothing else.
  const expected = swap(
    swap(REAL_DECK, nodeBytes("s0-brand"), nodeBytes("s0-main")),
    nodeBytes("s15-title"),
    nodeBytes("s15-main"),
  )
  expect(await contentOf(owner, shortId)).toBe(expected)
})

const LAYOUT_DOC = `<style>
.stack { width: 600px; padding: 20px; display: flex; flex-direction: column; gap: 16px }
.stack > [data-derive-node] { min-height: 80px; padding: 16px; border: 1px solid #ccd; box-sizing: border-box }
.stack > [data-derive-node][data-derive-size="compact"] { width: 50%; max-width: none }
.stack > [data-derive-node][data-derive-height] { height: var(--derive-structural-height); box-sizing: border-box }
</style>
<section class="stack" data-derive-region="story" data-derive-layout="stack">
  <article id="alpha" data-derive-node="alpha" data-derive-size="compact" style="color: navy">Alpha</article>
  <article id="bravo" data-derive-node="bravo"><p id="words">Bravo words.</p></article>
</section>`

test("[BROWSER-DECK-LAYOUT-001] a resize and a text edit save as one version: both, or neither", async ({
  owner,
}) => {
  const shortId = await publishArtifact(owner, "layout.html", LAYOUT_DOC, "text/html")
  await openArtifact(owner, shortId)
  const doc = frame(owner)
  const edit = async () => {
    await expect(async () => {
      if (!(await owner.getByTestId("inline-edit-bar").isVisible()))
        await owner.getByTestId("artifact-inline-edit").click()
      await doc.locator("#words").dblclick()
      await expect(doc.locator("#words")).toHaveAttribute("data-derive-editable", "1", {
        timeout: 1_000,
      })
    }).toPass({ timeout: 10_000 })
    await owner.keyboard.press("End")
    await owner.keyboard.type(" More.")
    await doc.locator("#alpha").click()
    const height = doc.getByRole("slider", { name: "Resize element height" })
    await height.focus()
    await height.press("ArrowDown")
    await expect(doc.locator("#alpha")).toHaveAttribute("data-derive-height", /^\d+$/)
    return doc.locator("#alpha").getAttribute("data-derive-height")
  }
  const versions: string[] = []
  owner.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/versions")) versions.push(r.url())
  })

  // Someone changes Alpha while this page is open: the save refuses as a whole, so
  // the untouched paragraph's edit is not saved either.
  await edit()
  const form = new FormData()
  form.append("edits", JSON.stringify([{ old_str: ">Alpha<", new_str: ">Alpha!<" }]))
  expect(
    (await owner.request.post(`/v1/artifacts/${shortId}/versions`, { multipart: form })).ok(),
  ).toBe(true)
  const head = await contentOf(owner, shortId)
  await owner.getByTestId("inline-edit-save").click()
  await expect(owner.getByText("The artifact changed while you were editing.")).toBeVisible()
  expect(await contentOf(owner, shortId)).toBe(head)
  expect(versions).toHaveLength(1)

  // From the current version, the same two edits land in one request and one version.
  await owner.getByTestId("inline-edit-discard").click()
  await owner.getByTestId("inline-edit-done").click()
  await owner.reload()
  versions.length = 0
  const px = await edit()
  await owner.getByTestId("inline-edit-save").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()
  const stored = await contentOf(owner, shortId)
  expect(versions).toHaveLength(1)
  expect(stored).toContain('<p id="words">Bravo words. More.</p>')
  const alpha = stored.match(/<article id="alpha"[^>]*>Alpha!<\/article>/)?.[0] ?? ""
  expect(alpha).toContain(`data-derive-height="${px}"`)
  expect(alpha).toContain(`style="color: navy; --derive-structural-height: ${px}px"`)
})

/** Invisible full-height prev/next buttons over the slide, as real decks paint them. */
const ZONES = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0}.stage{position:relative;min-height:100vh}.slide{padding:40px 60px}
.zone{position:absolute;top:0;bottom:0;width:17%;border:0;background:none}
.zone.l{left:0}.zone.r{right:0}
</style></head><body><div class="stage"><section class="slide">
<h2 id="title">Agenda</h2>
<p id="item">Automations and workflows.</p>
</section><button class="zone l" aria-label="Previous slide"></button><button class="zone r" aria-label="Next slide"></button></div>
</body></html>`

test("[BROWSER-FRAME-001] a click through an overlay moves typing to the clicked text", async ({
  owner,
}) => {
  const shortId = await publishArtifact(owner, "zones.html", ZONES, "text/html")
  await openArtifact(owner, shortId)
  const doc = frame(owner)

  // A frame that reloads while the page settles drops a mode entered too early;
  // enter (again) until a click arms the block.
  await expect(async () => {
    if (!(await owner.getByTestId("inline-edit-bar").isVisible()))
      await owner.getByTestId("artifact-inline-edit").click()
    await doc.locator("#item").click()
    await expect(doc.locator("#item")).toHaveAttribute("data-derive-editable", "1", {
      timeout: 1_000,
    })
  }).toPass({ timeout: 10_000 })
  await owner.keyboard.press("End")
  await owner.keyboard.type(" A")
  // The title's first letters sit under the left overlay button.
  await doc.locator("#title").click({ position: { x: 10, y: 8 }, force: true })
  await owner.keyboard.type("B")
  await expect(doc.locator("#item")).toHaveText("Automations and workflows. A")
  await expect(doc.locator("#title")).toContainText("B")

  await owner.getByTestId("inline-edit-save").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()
  await expect(async () => {
    const stored = await contentOf(owner, shortId)
    expect(stored).toContain('<p id="item">Automations and workflows. A</p>')
    expect(stored).toMatch(/<h2 id="title">[ABadegn]{7}<\/h2>/)
  }).toPass({ timeout: 10_000 })
})

test("[BROWSER-DECK-MOVE-001] move, duplicate, cut to another slide and delete save as exact-source ops", async ({
  owner,
}) => {
  const shortId = await openDeckEditor(owner)
  const doc = frame(owner)

  // Within a slide: the body moves above the brand row, then a copy follows it.
  await selectNode(owner, "s0-main")
  await doc.getByRole("button", { name: "Move earlier (Option+Up)" }).click()
  await owner.keyboard.press("ControlOrMeta+d")
  // Across slides: cut slide 2's title, paste it after slide 3's brand row.
  await showSlide(owner, 2)
  await selectNode(owner, "s1-title")
  await owner.keyboard.press("ControlOrMeta+x")
  await showSlide(owner, 3)
  await selectNode(owner, "s40-brand")
  await owner.keyboard.press("ControlOrMeta+v")
  // And a delete on the same slide.
  await selectNode(owner, "s40-sub")
  await owner.keyboard.press("Delete")
  await expect(doc.locator("[data-derive-node='s40-sub']")).toHaveCount(0)

  const ops = await saveOps(owner)
  expect(ops.map((op) => op.op)).toEqual(["content", "content", "content"])
  const before = slidesOf(REAL_DECK)
  const after = slidesOf(await contentOf(owner, shortId))
  expect(after).toHaveLength(before.length)
  const main =
    REAL_DECK.match(/<div class="body" data-derive-node="s0-main"[^\n]*<\/div>/)?.[0] ?? ""
  const brand = 'data-derive-node="s0-brand"'
  const title = '<h2 data-derive-node="s1-title" data-derive-kind="heading">India</h2>'
  // The moved body keeps its bytes; the copy differs only in its fresh node id.
  expect(after[0]?.indexOf(main)).toBeLessThan(after[0]?.indexOf(brand) ?? -1)
  expect(after[0]?.match(/<div class="body" data-derive-node="[^"]+"/g)).toHaveLength(2)
  expect(after[1]).not.toContain(title)
  expect(after[2]).toContain(title)
  expect(after[2]).not.toContain('data-derive-node="s40-sub"')
  // Every other slide is byte-identical.
  for (let i = 3; i < before.length; i++) expect(after[i]).toBe(before[i])
})

test("[BROWSER-DECK-BULK-001] ten edits on three slides and a move save once, exactly", async ({
  owner,
}) => {
  const shortId = await openDeckEditor(owner)
  const doc = frame(owner)
  const edits: [number, string][] = [
    [1, "Juliet Kilo Lima Mike"],
    [1, "Papa quebec Romeo sierra,"],
    [1, "Golf hotel india"],
    [2, "India"],
    [2, "Mike november oscar papa"],
    [2, "Golf hotel india juliet"],
    [3, "Golf hotel india juliet"],
    [3, "Sierra tango alpha bravo"],
    [3, "Juliet kilo lima."],
    [3, "Delta Echo"],
  ]
  let n = 0
  for (const [slide, text] of edits) {
    await showSlide(owner, slide)
    const target = doc
      .locator(`.slide:nth-of-type(${slide}) :text-is("${text}")`)
      .filter({ visible: true })
      .first()
    await target.dblclick()
    await owner.keyboard.press("End")
    await owner.keyboard.type(` edit${n++}`)
  }
  await showSlide(owner, 3)
  // A node nobody typed into (an armed block takes keys as typing).
  await selectNode(owner, "s40-brand")
  await owner.keyboard.press("Alt+ArrowDown")
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("11 unsaved changes")

  const ops = await saveOps(owner)
  expect(ops.length).toBeGreaterThan(0)
  const stored = await contentOf(owner, shortId)
  for (let i = 0; i < edits.length; i++) expect(stored).toContain(`edit${i}`)
  const before = slidesOf(REAL_DECK)
  const after = slidesOf(stored)
  for (let i = 3; i < before.length; i++) expect(after[i]).toBe(before[i])
  expect(after[2]?.indexOf('data-derive-node="s40-title"')).toBeLessThan(
    after[2]?.indexOf('data-derive-node="s40-brand"') ?? -1,
  )
})
