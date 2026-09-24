import { Buffer } from "node:buffer"
import type { Page } from "@playwright/test"
import { publishArtifact } from "../helpers"
import { expect, FUZZ_ON, test } from "./fixtures"
import { deckOf, outline, type SourceSlide } from "./html-tree"
import { checkArrange, checkArtifacts, checkEditDiff, checkWysiwyg, type Failure } from "./oracles"
import type { DomSlideCapture } from "./probe"
import { artifactFrame, contentOf, FIXTURE, openDeck, probe, renderTexts } from "./session"

/**
 * The harness checks itself before anyone trusts its numbers: a known-good edit must
 * pass every oracle, and deliberately corrupted saves must be caught by the oracle
 * responsible for each kind of damage.
 */

test.skip(!FUZZ_ON, "fuzz runs only with FUZZ=1 (pnpm test:fuzz)")

const oraclesOf = (fs: Failure[]) => [...new Set(fs.map((f) => f.oracle))].sort()

async function republish(page: Page, shortId: string, html: string) {
  const res = await page.request.post(`/v1/artifacts/${shortId}/versions`, {
    multipart: {
      file: { name: "deck.html", mimeType: "text/html", buffer: Buffer.from(html) },
      message: "Harness corruption",
    },
  })
  expect(res.ok(), `republish failed: ${res.status()}`).toBeTruthy()
}

test("the oracle's parser and text reader agree with the browser on the pristine deck", async ({
  fuzz,
}) => {
  const { page, render } = fuzz
  const shortId = await publishArtifact(page, "deck.html", FIXTURE, "text/html")
  await openDeck(page, shortId)
  await expect(page.getByTestId("deck-position")).toBeVisible()
  const frame = await artifactFrame(page)
  const deck = deckOf(FIXTURE)
  expect(deck.slides).toHaveLength(44)
  expect(await probe<string[]>(frame, "outlines")).toEqual(deck.slides.map((s) => outline(s.node)))
  // The served page and a bare render of the stored bytes read the same.
  const stored = await contentOf(page, shortId)
  expect(stored).toBe(FIXTURE)
  expect(await probe<string[]>(frame, "texts")).toEqual(await renderTexts(render, stored))
})

test("a known-good one-word edit passes every oracle, and corrupted saves are caught", async ({
  fuzz,
}) => {
  test.setTimeout(120_000)
  const { page, render } = fuzz
  const shortId = await publishArtifact(page, "deck.html", FIXTURE, "text/html")
  await openDeck(page, shortId)
  await expect(page.getByTestId("deck-position")).toBeVisible()
  let frame = await artifactFrame(page)
  await probe(frame, "show", 1)
  await page.getByTestId("deck-edit").click()
  await expect(page.getByTestId("inline-edit-bar")).toBeVisible()
  frame = await artifactFrame(page)
  const token = await probe<string>(frame, "snapshot")

  const title = page.frameLocator("iframe[title]").locator("[data-derive-node='s1-title']")
  // One click on a structural node selects the node; a double click arms its text.
  await title.dblclick({ position: { x: 12, y: 12 } })
  await page.keyboard.press("End")
  await page.keyboard.type(" Zulu")
  await page.waitForTimeout(300)
  const dom = await probe<DomSlideCapture[]>(frame, "capture", token)
  expect(dom.filter((d) => d.touched).map((d) => d.region)).toEqual(["slide-1"])
  expect(dom[1]?.changed).toEqual({ "node:s1-title": [[]] })

  await page.getByTestId("inline-edit-save").click()
  await expect(page.getByTestId("inline-edit-bar")).toBeHidden()
  const before = FIXTURE
  const saved = await contentOf(page, shortId)
  expect(saved).toContain(
    '<h2 data-derive-node="s1-title" data-derive-kind="heading">India Zulu</h2>',
  )

  const judge = async (after: string) => [
    ...checkWysiwyg(
      dom.map((d) => d.text),
      await renderTexts(render, after),
    ),
    ...checkEditDiff(before, after, dom),
    ...checkArtifacts(before, after),
  ]
  expect(await judge(saved)).toEqual([])

  // Each corruption goes through the API (a real stored version), then the same
  // captured page state is judged against it.
  const corrupt = async (mutate: (html: string) => string) => {
    const bad = mutate(saved)
    expect(bad).not.toBe(saved)
    await republish(page, shortId, bad)
    const stored = await contentOf(page, shortId)
    expect(stored).toBe(bad)
    return judge(stored)
  }
  // A word changed on a slide nobody touched: visible, and outside the edit.
  expect(
    oraclesOf(
      await corrupt((h) => h.replace("Oscar papa quebec, romeo", "Oscar papa quebec, romeX")),
    ),
  ).toEqual(["minimal-diff", "wysiwyg"])
  // Markup-only damage elsewhere: invisible to WYSIWYG, caught by the byte check.
  expect(
    oraclesOf(
      await corrupt((h) =>
        h.replace(
          '<div class="brand">Foxtrot <span class="x">×</span> Golf</div>',
          '<div class="brand">Foxtrot <span>×</span> Golf</div>',
        ),
      ),
    ),
  ).toEqual(["minimal-diff"])
  // The edited heading itself carries editor markup.
  expect(
    oraclesOf(
      await corrupt((h) =>
        h.replace(
          'data-derive-kind="heading">India Zulu',
          'data-derive-kind="heading" contenteditable="plaintext-only">India Zulu',
        ),
      ),
    ),
  ).toEqual(["artifacts"])
  // The edited heading saved different words than the page showed.
  expect(oraclesOf(await corrupt((h) => h.replace("India Zulu", "India Zulu Yankee")))).toEqual([
    "wysiwyg",
  ])
  // An edit that spilled out of its element into the neighbouring block.
  expect(
    oraclesOf(
      await corrupt((h) =>
        h.replace(
          'India Zulu</h2>\n  <div class="body" data-derive-node="s1-main"',
          'India Zulu</h2>\n  <div class="body" data-derive-node="s1-main" data-x="1"',
        ),
      ),
    ),
  ).toEqual(["minimal-diff"])
})

/** Pure oracle checks for moves, where a live gesture is not needed to build the case. */
test("moves: reordered blocks and slides pass only while their bytes are untouched", () => {
  const deck = deckOf(FIXTURE)
  const s1 = deck.slides[1] as SourceSlide
  const [brand, title] = s1.chunks as [(typeof s1.chunks)[0], (typeof s1.chunks)[0]]
  const brandBytes = FIXTURE.slice(brand.start, brand.end)
  const titleBytes = FIXTURE.slice(title.start, title.end)
  const swapped =
    FIXTURE.slice(0, brand.start) +
    titleBytes +
    FIXTURE.slice(brand.end, title.start) +
    brandBytes +
    FIXTURE.slice(title.end)
  const keys = s1.chunks.map((c) => c.key)
  const moved = [keys[1], keys[0], ...keys.slice(2)] as string[]
  const dom: DomSlideCapture[] = deck.slides.map((s, i) => ({
    region: s.region,
    text: "",
    chunks: i === 1 ? moved : s.chunks.map((c) => c.key),
    originalChunks: s.chunks.map((c) => c.key),
    changed: {},
    touched: i === 1,
  }))
  expect(checkEditDiff(FIXTURE, swapped, dom)).toEqual([])
  const damaged = swapped.replace(">India</h2>", ">IndiX</h2>")
  expect(checkEditDiff(FIXTURE, damaged, dom).map((f) => f.signature)).toEqual([
    "moved block's bytes changed",
  ])
  // The page showed the old order but the source moved: caught.
  const unmoved = dom.map((d, i) => (i === 1 ? { ...d, chunks: keys } : d))
  expect(checkEditDiff(FIXTURE, swapped, unmoved).map((f) => f.signature)).toContain(
    "saved block order differs from the edited page",
  )

  // Slide move + duplicate through the arrange oracle.
  const slides = deck.slides
  const bytes = (i: number) =>
    FIXTURE.slice((slides[i] as SourceSlide).start, (slides[i] as SourceSlide).end)
  const head = FIXTURE.slice(0, (slides[0] as SourceSlide).start)
  const tail = FIXTURE.slice((slides[slides.length - 1] as SourceSlide).end)
  const order = [1, 0, ...slides.slice(2).map((_, i) => i + 2)]
  const copy = bytes(2).replace(/data-derive-region="slide-40"/, 'data-derive-region="slide-99"')
  const arranged =
    head + [...order.map(bytes).slice(0, 3), copy, ...order.map(bytes).slice(3)].join("\n") + tail
  const model = [
    ...order.slice(0, 3).map((from) => ({ from, dup: false })),
    { from: 2, dup: true },
    ...order.slice(3).map((from) => ({ from, dup: false })),
  ]
  const texts = slides.map((_, i) => `slide ${i}`)
  const rendered = model.map((m) => texts[m.from] as string)
  expect(checkArrange(FIXTURE, arranged, model, texts, rendered)).toEqual([])
  const reusedIds =
    head +
    [...order.map(bytes).slice(0, 3), bytes(2), ...order.map(bytes).slice(3)].join("\n") +
    tail
  expect(checkArrange(FIXTURE, reusedIds, model, texts, rendered).map((f) => f.signature)).toEqual([
    "duplicated slide reuses its source's region id",
  ])
  const touchedMove = arranged.replace(
    "Mike november oscar papa</p>",
    "Mike november oscar papa!</p>",
  )
  expect(
    checkArrange(FIXTURE, touchedMove, model, texts, rendered).map((f) => f.signature),
  ).toEqual(["moved slide's bytes changed"])
})
