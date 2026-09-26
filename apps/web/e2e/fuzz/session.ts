import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { renderMarkdown } from "@derive/core"
import { expect, type Frame, type Page } from "@playwright/test"
import { publishArtifact } from "../helpers"
import {
  type ArrangeEntry,
  checkArrange,
  checkArtifacts,
  checkEditDiff,
  checkMarkdownDiff,
  checkMarkdownHtml,
  checkWysiwyg,
  type Failure,
} from "./oracles"
import { type DomSlideCapture, installProbe, type ProbeTargets, type Rect } from "./probe"
import { Rng } from "./rng"

const here = dirname(fileURLToPath(import.meta.url))

/** The real 44-slide deck with placeholder copy (packages/core/test/fixtures/decks). */
export const FIXTURE = readFileSync(
  join(here, "../../../../packages/core/test/fixtures/decks/structural-deck-44.html"),
  "utf8",
)
/** The document modes' fixtures: one synthetic article, as an HTML page and as the
 *  equivalent Markdown (docs/). */
export const DOC_FIXTURES = {
  "html-doc": {
    name: "article.html",
    mime: "text/html",
    src: readFileSync(join(here, "docs/article.html"), "utf8"),
  },
  markdown: {
    name: "article.md",
    mime: "text/markdown",
    src: readFileSync(join(here, "docs/article.md"), "utf8"),
  },
} as const
export type DocMode = keyof typeof DOC_FIXTURES
export const isDocMode = (mode: string | undefined): mode is DocMode =>
  mode === "html-doc" || mode === "markdown"

/** Session results live under the fuzz project's outputDir (FUZZ_OUT in the config). */
export const resultsDir = (outDir: string) => join(outDir, "results")

export type ActionType =
  | "type"
  | "dblclick"
  | "tripleclick"
  | "shiftClick"
  | "shiftArrows"
  | "backspaceRun"
  | "deleteRun"
  | "enter"
  | "format"
  | "selectAll"
  | "nonText"
  | "move"
  | "moveSibling"
  | "resize"
  | "switchSlide"
  | "listItem"
  | "tableCell"
  | "undo"
  | "arrange:up"
  | "arrange:down"
  | "arrange:drag"
  | "arrange:duplicate"
  | "arrange:delete"

const EDIT_WEIGHTS = {
  type: 16,
  dblclick: 8,
  tripleclick: 5,
  shiftClick: 10,
  shiftArrows: 10,
  backspaceRun: 8,
  deleteRun: 6,
  enter: 6,
  format: 7,
  selectAll: 5,
  nonText: 8,
  move: 8,
  moveSibling: 6,
} as const
/** One slide, many changes: the same gestures plus resizing a block's box. */
const ONE_SLIDE_WEIGHTS = { ...EDIT_WEIGHTS, resize: 5 } as const
/** One section of a document: the text gestures, plus edits aimed at list items and
 *  table cells and ⌘Z/⌘⇧Z. No author nodes to move or resize on an article; repeated
 *  list items and table rows move on an HTML page (the block pill), and Markdown has
 *  no moves at all. */
const DOC_TEXT_WEIGHTS = {
  type: 16,
  dblclick: 8,
  tripleclick: 5,
  shiftClick: 10,
  shiftArrows: 10,
  backspaceRun: 8,
  deleteRun: 6,
  enter: 6,
  format: 7,
  selectAll: 5,
  nonText: 4,
  listItem: 7,
  tableCell: 7,
  undo: 3,
} as const
const DOC_WEIGHTS: Record<DocMode, { [K in ActionType]?: number }> = {
  "html-doc": { ...DOC_TEXT_WEIGHTS, moveSibling: 6 },
  markdown: DOC_TEXT_WEIGHTS,
}

export interface ActionLog {
  n: number
  phase: "arrange" | "edit"
  type: ActionType
  slide?: number
  detail: Record<string, unknown>
}

export interface SessionResult {
  seed: number
  ok: boolean
  failures: (Failure & { phase: string })[]
  actions: ActionLog[]
  actionTypes: ActionType[]
  editActions: number
  arranged: boolean
  /** What the edit pass actually exercised, from the page capture before the save. */
  stats: { touchedSlides: number; reorderedSlides: number; edits: number }
  ms: number
}

export interface SessionOptions {
  /** The fuzz project's outputDir: results/<seed>.json and <seed>/ artifacts go here. */
  outDir: string
  /** Replay only the first N edit actions of the seed's plan (manual shrinking). */
  maxActions?: number
  /** Force the Rearrange phase on or off; by default ~30% of classic sessions arrange
   *  first (one-slide sessions don't, unless forced on). */
  arrange?: "auto" | "on" | "off"
  /** "one-slide" (default): 8–15 changes on one slide, save, then 5–8 more on the same
   *  slide and a second save (stale ids after a save show up there). "classic": 5–10
   *  changes over one to three slides and one save. */
  mode?: "one-slide" | "classic" | DocMode
}

export interface FuzzPages {
  page: Page
  /** A blank page used to render stored source for the WYSIWYG oracle. */
  render: Page
}

// ---------------------------------------------------------------------------------
// Probe plumbing

export async function artifactFrame(page: Page): Promise<Frame> {
  const handle = await page.locator("iframe[title]").elementHandle({ timeout: 15_000 })
  const frame = await handle?.contentFrame()
  if (!frame) throw new Error("artifact frame not found")
  return frame
}

export async function probe<T>(target: Page | Frame, name: string, ...args: unknown[]): Promise<T> {
  await target.evaluate(installProbe)
  return target.evaluate(
    ([fn, a]) =>
      (
        (window as unknown as { __fuzz: Record<string, (...x: unknown[]) => unknown> }).__fuzz[
          fn as string
        ] as (...x: unknown[]) => unknown
      )(...(a as unknown[])),
    [name, args] as const,
  ) as Promise<T>
}

/** Open a deck and wait for its bar. Not helpers' openArtifact: that waits on the
 *  comment rail, which a Rearrange pass in an earlier session may have collapsed. */
export async function openDeck(page: Page, shortId: string): Promise<void> {
  await page.goto(`/artifacts/${shortId}`)
  await expect(page.getByTestId("deck-position")).toBeVisible()
}

/** Open an article or Markdown doc and wait for its rendered frame. */
export async function openDoc(page: Page, shortId: string): Promise<void> {
  await page.goto(`/artifacts/${shortId}`)
  await expect(page.getByTestId("artifact-inline-edit")).toBeVisible()
  await expect
    .poll(async () => probe<number>(await artifactFrame(page), "sectionCount").catch(() => 0), {
      timeout: 15_000,
    })
    .toBeGreaterThan(1)
}

export async function contentOf(page: Page, shortId: string): Promise<string> {
  const res = await page.request.get(`/v1/artifacts/${shortId}/content`)
  expect(res.ok(), `content fetch failed: ${res.status()}`).toBeTruthy()
  return res.text()
}

/** Render stored source in a clean page and read each slide's visible text. */
export async function renderTexts(render: Page, src: string): Promise<string[]> {
  await render.evaluate(() => {
    delete (window as unknown as { __fuzz?: unknown }).__fuzz
  })
  await render.setContent(src, { waitUntil: "domcontentloaded" })
  return probe<string[]>(render, "texts")
}

// ---------------------------------------------------------------------------------
// Gestures

type Ctx = {
  page: Page
  rng: Rng
  log: ActionLog[]
  failures: (Failure & { phase: string })[]
  slide: number
  phase: "arrange" | "edit"
  stats: SessionResult["stats"]
  /** Set on a document session: which fixture, and so which oracles and gestures. */
  doc: DocMode | null
}

const inside = (r: Rect, x: number, y: number, pad = 0) =>
  x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad

async function targets(ctx: Ctx): Promise<ProbeTargets> {
  const frame = await artifactFrame(ctx.page)
  // Aim only once the page stopped moving: arming a block that sits past the frame's
  // edge scrolls it into view smoothly, and points measured mid-scroll land elsewhere.
  let last = ""
  for (let i = 0; i < 20; i++) {
    const now = await probe<string>(frame, "layoutSig")
    if (now === last) break
    last = now
    await ctx.page.waitForTimeout(80)
  }
  return probe<ProbeTargets>(frame, "targets", ctx.rng.int(1, 2 ** 30))
}

/** Frame viewport point → page point (the frame may be scaled to fit). */
async function toPage(ctx: Ctx, view: { w: number; h: number }, x: number, y: number) {
  const box = await ctx.page.locator("iframe[title]").boundingBox()
  if (!box) throw new Error("artifact frame has no box")
  return { x: box.x + (x * box.width) / view.w, y: box.y + (y * box.height) / view.h }
}

async function clickAt(
  ctx: Ctx,
  view: { w: number; h: number },
  pt: { x: number; y: number },
  opts: { count?: number; shift?: boolean } = {},
) {
  const p = await toPage(ctx, view, pt.x, pt.y)
  if (opts.shift) await ctx.page.keyboard.down("Shift")
  await ctx.page.mouse.click(p.x, p.y, { clickCount: opts.count ?? 1, delay: 15 })
  if (opts.shift) await ctx.page.keyboard.up("Shift")
}

const textPoint = (rng: Rng, r: Rect) => ({
  x: r.x + 1 + rng.next() * Math.max(0, r.w - 2),
  y: r.y + r.h * (0.3 + 0.4 * rng.next()),
})

const VOCAB = [
  "zulu",
  "Quark",
  "x",
  "42",
  "naïve",
  "über",
  "Ω",
  "—",
  "&",
  "<b>",
  '"q"',
  "it's",
  "a  b",
  "e.g.",
  "Tab?",
  "3 < 4 > 2",
  "&amp;",
  "🙂",
]
/** Markdown is source: typed `<b>` is live HTML and `&amp;` an entity (see the targeted
 *  inline-edit test). The Markdown fuzz types words that read as themselves. */
const MARKDOWN_VOCAB = VOCAB.filter((w) => w !== "<b>" && w !== "&amp;")
function typedText(rng: Rng, doc: DocMode | null = null): string {
  const vocab = doc === "markdown" ? MARKDOWN_VOCAB : VOCAB
  const words = Array.from({ length: rng.int(1, 3) }, () => rng.pick(vocab))
  let s = words.join(rng.chance(0.2) ? "" : " ")
  if (rng.chance(0.25)) s = ` ${s}`
  if (rng.chance(0.2)) s = `${s} `
  return s
}

/** What to do with a selection once it exists. */
async function finish(ctx: Ctx, detail: Record<string, unknown>) {
  const then = ctx.rng.weighted({
    type: 5,
    backspace: 3,
    delete: 2,
    bold: 1.5,
    italic: 1,
    enter: 0.5,
  })
  detail.after = then
  const k = ctx.page.keyboard
  if (then === "type") {
    const text = typedText(ctx.rng, ctx.doc)
    detail.text = text
    await k.type(text, { delay: 5 })
  } else if (then === "backspace") await k.press("Backspace")
  else if (then === "delete") await k.press("Delete")
  else if (then === "bold") await k.press("ControlOrMeta+b")
  else if (then === "italic") await k.press("ControlOrMeta+i")
  else await k.press("Enter")
}

/**
 * Put a caret at a text point the way a person does. One click on words always
 * places a caret, inside a structural node or a card too; sometimes a person double
 * clicks instead and then collapses the word selection with an arrow (or keeps it,
 * to type over it).
 */
async function placeCaret(
  ctx: Ctx,
  view: { w: number; h: number },
  pt: { x: number; y: number },
  detail: Record<string, unknown>,
) {
  const armed = await probe<boolean>(await artifactFrame(ctx.page), "armedAt", pt.x, pt.y)
  if (armed || ctx.rng.chance(0.6)) {
    detail.arm = "click"
    await clickAt(ctx, view, pt)
    return
  }
  const collapse = ctx.rng.pick(["ArrowLeft", "ArrowRight", "keep"] as const)
  detail.arm = `dblclick+${collapse}`
  await clickAt(ctx, view, pt, { count: 2 })
  if (collapse !== "keep") await ctx.page.keyboard.press(collapse)
}

/**
 * Move the selected block: Option+arrows, the pill's arrow buttons, or a drag of the
 * pill's name onto a sibling. Returns false (with `detail.skipped`) when nothing was
 * selected to move.
 */
async function moveSelected(
  ctx: Ctx,
  view: { w: number; h: number },
  detail: Record<string, unknown>,
) {
  const { page, rng } = ctx
  const k = page.keyboard
  await settle(page, 150)
  const frame = await artifactFrame(page)
  if (!(await probe<boolean>(frame, "pill"))) {
    detail.skipped = "block did not select"
    return
  }
  const how = rng.weighted({ key: 5, button: 3, drag: 2 })
  const back = rng.chance(0.5)
  Object.assign(detail, { how, back })
  if (how === "key") {
    const times = rng.int(1, 2)
    const key = rng.pick(
      back ? ["Alt+ArrowUp", "Alt+ArrowLeft"] : ["Alt+ArrowDown", "Alt+ArrowRight"],
    )
    Object.assign(detail, { times, key })
    for (let i = 0; i < times; i++) await k.press(key)
  } else if (how === "button") {
    const button = page
      .frameLocator("iframe[title]")
      .getByRole("button", { name: back ? "Move earlier" : "Move later" })
    if (await button.isEnabled({ timeout: 2000 }).catch(() => false)) await button.click()
    else detail.skipped = "move button disabled"
  } else {
    const grip = await probe<Rect | null>(frame, "grip")
    const siblings = await probe<Rect[]>(frame, "siblingRects")
    if (!grip || !siblings.length) {
      detail.skipped = "no grip or drop target"
      return
    }
    const dest = rng.pick(siblings)
    detail.onto = dest
    const from = await toPage(ctx, view, grip.x + grip.w / 2, grip.y + grip.h / 2)
    const to = await toPage(
      ctx,
      view,
      dest.x + dest.w * (back ? 0.25 : 0.75),
      dest.y + dest.h * (back ? 0.25 : 0.75),
    )
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 10 })
    await page.mouse.up()
  }
  await settle(page, 150)
}

async function settle(page: Page, ms = 120) {
  await page.waitForTimeout(ms)
}

/**
 * Run a single-point gesture and check that whatever text changed sits in a block
 * under that point — typing follows the click, never an earlier block.
 */
async function withLeakCheck(
  ctx: Ctx,
  pt: { x: number; y: number },
  type: ActionType,
  run: () => Promise<void>,
) {
  const frame = await artifactFrame(ctx.page)
  await probe(frame, "mark", pt.x, pt.y)
  const activeBefore = await probe<{ rect: Rect; label: string } | null>(frame, "activeBlock")
  await run()
  await settle(ctx.page)
  const changed = await probe<{ rect: Rect; label: string; atPoint: boolean }[]>(
    frame,
    "changedBlocks",
  )
  for (const c of changed) {
    // Allowed: the editable block that holds the clicked point (it may have reflowed
    // away from it since), or any block still under the point.
    if (c.atPoint || inside(c.rect, pt.x, pt.y, 8)) continue
    const intoPrevious = activeBefore && activeBefore.label === c.label
    ctx.failures.push({
      phase: ctx.phase,
      oracle: "leak",
      signature: intoPrevious
        ? `${type}: typing landed in the previously edited block, not where the click was`
        : `${type}: typing landed in a block away from the click`,
      message: `click at (${pt.x.toFixed(0)},${pt.y.toFixed(0)}) changed ${c.label} at ${JSON.stringify(c.rect)}`,
      slide: ctx.slide + 1,
    })
  }
}

async function editAction(ctx: Ctx, type: ActionType, n: number) {
  const { page, rng } = ctx
  const t = await targets(ctx)
  const detail: Record<string, unknown> = {}
  const entry: ActionLog = { n, phase: "edit", type, slide: ctx.slide + 1, detail }
  ctx.log.push(entry)
  const k = page.keyboard
  if (
    type !== "nonText" &&
    type !== "move" &&
    type !== "moveSibling" &&
    type !== "undo" &&
    !t.text.length
  ) {
    detail.skipped = "no visible text on this slide"
    return
  }
  const aimText = () => {
    const target = rng.pick(t.text)
    const pt = textPoint(rng, target.rect)
    return { pt, label: target.label }
  }
  switch (type) {
    case "type": {
      const { pt, label } = aimText()
      const text = typedText(rng, ctx.doc)
      Object.assign(detail, { at: label, text })
      // Sometimes just one click, as people do: on words that places the caret too.
      const single = rng.chance(0.2)
      await withLeakCheck(ctx, pt, type, async () => {
        if (single) {
          detail.arm = "single-click"
          await clickAt(ctx, t.view, pt)
        } else await placeCaret(ctx, t.view, pt, detail)
        await k.type(text, { delay: 5 })
      })
      return
    }
    case "dblclick":
    case "tripleclick": {
      const { pt, label } = aimText()
      detail.at = label
      await clickAt(ctx, t.view, pt, { count: type === "dblclick" ? 2 : 3 })
      await finish(ctx, detail)
      return
    }
    case "shiftClick": {
      const a = aimText()
      const b = rng.chance(0.4)
        ? {
            pt: textPoint(rng, rng.pick(t.text.filter((x) => x.label === a.label)).rect),
            label: a.label,
          }
        : aimText()
      Object.assign(detail, { from: a.label, to: b.label })
      await placeCaret(ctx, t.view, a.pt, detail)
      await clickAt(ctx, t.view, b.pt, { shift: true })
      await finish(ctx, detail)
      return
    }
    case "shiftArrows": {
      const { pt, label } = aimText()
      const keys = Array.from({ length: rng.int(1, 12) }, () =>
        rng.weighted({
          ArrowRight: 4,
          ArrowLeft: 3,
          ArrowDown: 1.5,
          ArrowUp: 1,
          End: 0.5,
          Home: 0.5,
        }),
      )
      Object.assign(detail, { at: label, keys })
      await placeCaret(ctx, t.view, pt, detail)
      for (const key of keys) await k.press(`Shift+${key}`)
      await finish(ctx, detail)
      return
    }
    case "backspaceRun":
    case "deleteRun": {
      const { pt, label } = aimText()
      const count = rng.int(1, 14)
      Object.assign(detail, { at: label, count })
      await withLeakCheck(ctx, pt, type, async () => {
        await placeCaret(ctx, t.view, pt, detail)
        for (let i = 0; i < count; i++)
          await k.press(type === "backspaceRun" ? "Backspace" : "Delete")
      })
      return
    }
    case "enter": {
      const { pt, label } = aimText()
      const text = rng.chance(0.6) ? typedText(rng, ctx.doc) : ""
      Object.assign(detail, { at: label, text })
      await withLeakCheck(ctx, pt, type, async () => {
        await placeCaret(ctx, t.view, pt, detail)
        await k.press("Enter")
        if (text) await k.type(text, { delay: 5 })
      })
      return
    }
    case "format": {
      const { pt, label } = aimText()
      const how = rng.pick(["dblclick", "shiftArrows"] as const)
      const fmt = rng.pick(["ControlOrMeta+b", "ControlOrMeta+i"] as const)
      Object.assign(detail, { at: label, how, fmt })
      if (how === "dblclick") await clickAt(ctx, t.view, pt, { count: 2 })
      else {
        await placeCaret(ctx, t.view, pt, detail)
        for (let i = rng.int(2, 8); i > 0; i--) await k.press("Shift+ArrowRight")
      }
      await k.press(fmt)
      if (rng.chance(0.3)) {
        detail.text = typedText(rng, ctx.doc)
        await k.type(detail.text as string, { delay: 5 })
      }
      return
    }
    case "selectAll": {
      const { pt, label } = aimText()
      const text = typedText(rng, ctx.doc)
      Object.assign(detail, { at: label, text })
      await placeCaret(ctx, t.view, pt, detail)
      await k.press("ControlOrMeta+a")
      await k.type(text, { delay: 5 })
      return
    }
    case "nonText": {
      if (!t.empty.length) {
        detail.skipped = "no empty space on this slide"
        return
      }
      const pt = rng.pick(t.empty)
      const text = rng.pick(["Q", "zz", "leak"])
      Object.assign(detail, { at: pt, text })
      // Half the time a block is being edited first — the classic leak is typing that
      // lands back in it after a click elsewhere.
      if (rng.chance(0.5) && t.text.length) {
        const a = aimText()
        detail.primed = a.label
        await placeCaret(ctx, t.view, a.pt, detail)
        await k.type("p", { delay: 5 })
      }
      await withLeakCheck(ctx, pt, type, async () => {
        await clickAt(ctx, t.view, pt)
        await k.type(text, { delay: 5 })
      })
      return
    }
    case "move": {
      // An author-declared node, picked up by a point inside it away from its words
      // (which may land in a repeated card inside it: that is a block too).
      const nodes = t.nodes.filter((node) => node.grab)
      if (nodes.length < 2) {
        detail.skipped = "fewer than two grabbable nodes"
        return
      }
      const node = rng.pick(nodes)
      detail.node = node.id
      await clickAt(ctx, t.view, node.grab as { x: number; y: number })
      await moveSelected(ctx, t.view, detail)
      return
    }
    case "moveSibling": {
      // A card, item or column with no author markup: movable because it repeats.
      const repeats = t.repeats.filter((r) => r.grab)
      if (!repeats.length) {
        detail.skipped = "no repeated siblings with room to grab"
        return
      }
      const target = rng.pick(repeats)
      detail.block = target.label
      await clickAt(ctx, t.view, target.grab as { x: number; y: number })
      // In an article the space beside a list item or a row is still its line, so the
      // click lands a caret; Escape then steps out of the words to their block.
      if (ctx.doc) {
        await settle(page, 150)
        for (let i = 0; i < 2 && !(await probe<boolean>(await artifactFrame(page), "pill")); i++) {
          await k.press("Escape")
          detail.escapes = i + 1
          await settle(page, 150)
        }
      }
      await moveSelected(ctx, t.view, detail)
      return
    }
    case "listItem":
    case "tableCell": {
      // Words in a list item or a table cell: type into them, retype a word, or delete.
      const want = type === "listItem" ? ["li"] : ["td", "th"]
      const pool = t.text.filter((x) => want.includes(x.block))
      if (!pool.length) {
        detail.skipped = `no ${type === "listItem" ? "list item" : "table cell"} in this section`
        return
      }
      const target = rng.pick(pool)
      const pt = textPoint(rng, target.rect)
      const how = rng.weighted({ type: 4, retype: 3, backspace: 2, end: 2 })
      Object.assign(detail, { at: target.label, how })
      await withLeakCheck(ctx, pt, type, async () => {
        if (how === "retype") {
          await clickAt(ctx, t.view, pt, { count: 2 })
          detail.text = typedText(rng, ctx.doc)
          await k.type(detail.text as string, { delay: 5 })
          return
        }
        await placeCaret(ctx, t.view, pt, detail)
        if (how === "end") {
          await k.press("End")
          detail.text = typedText(rng, ctx.doc)
          await k.type(detail.text as string, { delay: 5 })
        } else if (how === "type") {
          detail.text = typedText(rng, ctx.doc)
          await k.type(detail.text as string, { delay: 5 })
        } else {
          detail.count = rng.int(1, 8)
          for (let i = 0; i < (detail.count as number); i++) await k.press("Backspace")
        }
      })
      return
    }
    case "undo": {
      const times = rng.int(1, 3)
      const redo = rng.chance(0.4)
      Object.assign(detail, { times, redo })
      for (let i = 0; i < times; i++) await k.press("ControlOrMeta+z")
      if (redo) await k.press("ControlOrMeta+Shift+z")
      return
    }
    case "resize": {
      const nodes = t.nodes.filter((node) => node.grab)
      if (!nodes.length) {
        detail.skipped = "no grabbable node"
        return
      }
      const node = rng.pick(nodes)
      detail.node = node.id
      await clickAt(ctx, t.view, node.grab as { x: number; y: number })
      await settle(page, 150)
      const handle = rng.pick(["derive-block-rz-e", "derive-block-rz-se"])
      const box = await probe<Rect | null>(await artifactFrame(page), "handle", handle)
      if (!box) {
        detail.skipped = "no enabled resize handle"
        return
      }
      const dx = rng.pick([-1, 1]) * rng.int(12, 90)
      const dy = rng.pick([-1, 1]) * rng.int(12, 60)
      Object.assign(detail, { handle, dx, dy })
      const from = await toPage(ctx, t.view, box.x + box.w / 2, box.y + box.h / 2)
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 })
      await page.mouse.up()
      await settle(page, 150)
      return
    }
    default:
      throw new Error(`unknown edit action ${type}`)
  }
}

// ---------------------------------------------------------------------------------
// Saving

type SaveOutcome =
  | { kind: "ok"; skipped: { index: number; message: string }[]; edits: unknown }
  | { kind: "error"; status: number; message: string; edits: unknown }
  | { kind: "no-request"; toasts: string[] }

const editsOf = (postData: string | null): unknown => {
  const m = postData?.match(/name="(?:edits|slide_ops|ops)"\r\n\r\n([\s\S]*?)\r\n--/)
  if (!m) return null
  try {
    return JSON.parse(m[1] as string)
  } catch {
    return m[1]
  }
}

async function awaitSave(
  page: Page,
  shortId: string,
  click: () => Promise<void>,
  expectRequest: boolean,
): Promise<SaveOutcome> {
  // Toasts time out on their own, so collect every one seen while waiting.
  const seen = new Set<string>()
  let waiting = true
  const watchToasts = (async () => {
    while (waiting) {
      for (const t of await page
        .locator("[data-sonner-toast]")
        .allInnerTexts()
        .catch(() => []))
        seen.add(t.replace(/\s+/g, " ").trim())
      await page.waitForTimeout(250).catch(() => {})
    }
  })()
  const response = page
    .waitForResponse(
      (r) =>
        r.url().includes(`/v1/artifacts/${shortId}/versions`) && r.request().method() === "POST",
      { timeout: expectRequest ? 25_000 : 6_000 },
    )
    .catch(() => null)
  await click()
  const res = await response
  waiting = false
  await watchToasts
  if (!res) return { kind: "no-request", toasts: [...seen].filter((t) => !/^Saved/.test(t)) }
  const edits = editsOf(res.request().postData())
  const body = (await res.json().catch(() => null)) as {
    skipped_edits?: { index: number; message: string }[]
    error?: { message?: string } | string
    message?: string
  } | null
  if (!res.ok()) {
    const err = body?.error
    const message =
      (typeof err === "string" ? err : err?.message) ?? body?.message ?? JSON.stringify(body)
    return { kind: "error", status: res.status(), message, edits }
  }
  return { kind: "ok", skipped: body?.skipped_edits ?? [], edits }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes from expect messages
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "")

/** Numbers and quoted text vary per seed; strip them so one bug is one signature. */
export const genericize = (s: string) =>
  stripAnsi(s)
    .replace(/"[^"]*"|“[^”]*”/g, '"…"')
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .slice(0, 140)

// ---------------------------------------------------------------------------------
// Phases

async function arrangePhase(ctx: Ctx, fp: FuzzPages, shortId: string, save: SaveRecorder) {
  const { page, rng } = ctx
  ctx.phase = "arrange"
  const before = await contentOf(page, shortId)
  const beforeTexts = await renderTexts(fp.render, before)
  await page.getByTestId("deck-arrange").click()
  await expect(page.getByTestId("deck-organizer")).toBeVisible()
  const labels = async () =>
    (
      await page
        .locator('[data-testid^="deck-slide-select-"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""))
    ).map((l) => l.replace(/^Slide \d+, /, ""))
  const initial = await labels()
  type M = ArrangeEntry & { label: string }
  let model: M[] = initial.map((label, i) => ({ from: i, dup: false, label }))
  const ops = rng.int(1, 4)
  for (let i = 0; i < ops; i++) {
    const op = rng.weighted({ up: 2, down: 2, drag: 3, duplicate: 2, delete: 2 })
    const type = `arrange:${op}` as ActionType
    const detail: Record<string, unknown> = {}
    ctx.log.push({ n: ctx.log.length + 1, phase: "arrange", type, detail })
    const len = model.length
    const next = [...model]
    if (op === "up" || op === "down") {
      const p = op === "up" ? rng.int(2, len) : rng.int(1, len - 1)
      detail.slide = p
      const card = page.getByTestId(`deck-slide-card-${p}`)
      await card.scrollIntoViewIfNeeded()
      await card.hover()
      // The move buttons show on hover or focus within the card; focus keeps them up
      // even if the list shifts under the pointer after the hover.
      await page.getByTestId(`deck-slide-drag-${p}`).focus()
      await page.getByTestId(`deck-slide-${op}-${p}`).click()
      const [m] = next.splice(p - 1, 1)
      next.splice(op === "up" ? p - 2 : p, 0, m as M)
    } else if (op === "drag") {
      const p = rng.int(1, len)
      let q = Math.min(len, Math.max(1, p + rng.pick([-4, -3, -2, -1, 1, 2, 3, 4])))
      if (q === p) q = p === 1 ? 2 : p - 1
      Object.assign(detail, { from: p, to: q })
      await page.getByTestId(`deck-slide-card-${p}`).scrollIntoViewIfNeeded()
      await page
        .getByTestId(`deck-slide-drag-${p}`)
        .dragTo(page.getByTestId(`deck-slide-card-${q}`))
      const [m] = next.splice(p - 1, 1)
      next.splice(q - 1, 0, m as M)
    } else if (op === "duplicate") {
      const p = rng.int(1, len)
      detail.slide = p
      await page.getByTestId(`deck-slide-card-${p}`).scrollIntoViewIfNeeded()
      await page.getByTestId(`deck-slide-more-${p}`).click()
      await page.getByTestId(`deck-slide-duplicate-${p}`).click()
      const src = next[p - 1] as M
      next.splice(p, 0, { from: src.from, dup: true, label: `${src.label} copy` })
    } else {
      if (len <= 2) {
        detail.skipped = "keep at least two slides"
        continue
      }
      const p = rng.int(1, len)
      detail.slide = p
      await page.getByTestId(`deck-slide-card-${p}`).scrollIntoViewIfNeeded()
      await page.getByTestId(`deck-slide-more-${p}`).click()
      await page.getByTestId(`deck-slide-remove-${p}`).click()
      await page.getByTestId("deck-remove-confirm").click()
      await expect(page.getByTestId("deck-remove-confirm")).toBeHidden()
      next.splice(p - 1, 1)
    }
    const prev = model
    const was = prev.map((m) => m.label)
    model = next
    await expect
      .poll(labels, { timeout: 5_000 })
      .toEqual(model.map((m) => m.label))
      .catch(async () => {
        const shown = await labels()
        // A synthetic HTML5 drop across a scrolled list sometimes never fires; that
        // is the driver, not the panel. Keep the unchanged order and go on.
        if (op === "drag" && shown.join("|") === was.join("|")) {
          detail.skipped = "drop did not register"
          model = prev
          return
        }
        // Or the list auto-scrolls under the pointer mid-drag and the drop lands on
        // another slot (or picks up the card now under the handle). Still one card
        // moved: follow what the panel did.
        if (op === "drag")
          for (let from = 0; from < prev.length; from++)
            for (let to = 0; to < prev.length; to++) {
              const moved = [...prev]
              const [card] = moved.splice(from, 1)
              moved.splice(to, 0, card as M)
              if (from === to || moved.map((m) => m.label).join("|") !== shown.join("|")) continue
              Object.assign(detail, { landed: { from: from + 1, to: to + 1 } })
              model = moved
              return
            }
        ctx.failures.push({
          phase: "arrange",
          oracle: "arrange-model",
          signature: `Rearrange panel order disagrees with the gesture (${op})`,
          message: `expected [${model.map((m) => m.label).join(" | ")}], panel shows [${(await labels()).join(" | ")}]`,
        })
      })
    if (ctx.failures.some((f) => f.oracle === "arrange-model")) return
  }
  // Every gesture may have been a drop that never registered: nothing to save, and
  // the panel rightly keeps Save disabled. Close it and go on to the edit pass.
  if (model.every((m, i) => m.from === i && !m.dup) && model.length === initial.length) {
    await page.getByTestId("deck-arrange-close").click()
    await expect(page.getByTestId("deck-organizer")).toBeHidden()
    return
  }
  const outcome = await awaitSave(
    page,
    shortId,
    () => page.getByTestId("deck-arrange-save").click(),
    true,
  )
  save("arrange", outcome)
  if (outcome.kind !== "ok") {
    ctx.failures.push({
      phase: "arrange",
      oracle: "save",
      signature:
        outcome.kind === "error"
          ? `arrange save refused: ${genericize(outcome.message)}`
          : "arrange save never sent",
      message: outcome.kind === "error" ? outcome.message : outcome.toasts.join(" / "),
    })
    return
  }
  await expect(page.getByTestId("deck-organizer")).toBeHidden()
  const after = await contentOf(page, shortId)
  const rendered = await renderTexts(fp.render, after)
  for (const f of [
    ...checkArrange(before, after, model, beforeTexts, rendered),
    ...checkArtifacts(before, after),
  ])
    ctx.failures.push({ ...f, phase: "arrange" })
  save.sources("arrange", before, after)
  await expect(page.getByTestId("deck-position")).toContainText(`/ ${model.length}`)
  // The frame reloads onto the saved version; the edit pass must start on that one.
  await expect
    .poll(async () => probe<number>(await artifactFrame(page), "slideCount").catch(() => -1), {
      timeout: 15_000,
    })
    .toBe(model.length)
}

/** A one-slide round: which slide, how many gestures, and what the save is called. */
type Round = { slide: number; actions: number; label: string }

/** One edit pass and its save. Returns whether it ended in a clean, checked save. */
async function editPhase(
  ctx: Ctx,
  fp: FuzzPages,
  shortId: string,
  opts: SessionOptions,
  save: SaveRecorder,
  round?: Round,
): Promise<boolean> {
  const { page, rng } = ctx
  const label = round?.label ?? "edit"
  ctx.phase = "edit"
  const failuresBefore = ctx.failures.length
  const before = await contentOf(page, shortId)
  let frame = await artifactFrame(page)
  const total = await probe<number>(frame, "slideCount")
  const slideSpan = round ? 1 : rng.chance(0.25) ? rng.int(2, 3) : 1
  const slides: number[] = round ? [round.slide] : []
  while (slides.length < slideSpan) {
    const s = rng.int(0, total - 1)
    if (!slides.includes(s)) slides.push(s)
  }
  let nActions = round?.actions ?? rng.int(5, 10)
  const weights: Record<string, number> = ctx.doc
    ? DOC_WEIGHTS[ctx.doc]
    : round
      ? ONE_SLIDE_WEIGHTS
      : EDIT_WEIGHTS
  const plan = Array.from({ length: nActions }, () => rng.weighted(weights) as ActionType)
  const switches = new Set<number>()
  while (switches.size < slideSpan - 1) switches.add(rng.int(1, nActions - 1))
  if (opts.maxActions !== undefined) nActions = Math.min(nActions, opts.maxActions)

  ctx.slide = slides[0] as number
  await probe(frame, "show", ctx.slide)
  // After a save the session picks back up by itself, on the same slide.
  if (!(await page.getByTestId("inline-edit-bar").isVisible()))
    await page.getByTestId(ctx.doc ? "artifact-inline-edit" : "deck-edit").click()
  await expect(page.getByTestId("inline-edit-bar")).toBeVisible()
  frame = await artifactFrame(page)
  // A doc: back to the section's top once the mode's chrome has settled.
  if (ctx.doc) await probe(frame, "show", ctx.slide)
  const token = await probe<string>(frame, "snapshot")
  let slideAt = 0
  for (let i = 0; i < nActions; i++) {
    if (switches.has(i)) {
      slideAt++
      ctx.slide = slides[slideAt] as number
      ctx.log.push({
        n: ctx.log.length + 1,
        phase: "edit",
        type: "switchSlide",
        slide: ctx.slide + 1,
        detail: {},
      })
      await probe(await artifactFrame(page), "show", ctx.slide)
    }
    await editAction(ctx, plan[i] as ActionType, ctx.log.length + 1)
  }
  await settle(page, 400)
  frame = await artifactFrame(page)
  const dom = await probe<DomSlideCapture[]>(frame, "capture", token)
  save.shot(`before-save-${label}`, await page.screenshot())
  const touched = dom.some((d) => d.touched)
  ctx.stats.touchedSlides = dom.filter((d) => d.touched).length
  ctx.stats.reorderedSlides = dom.filter(
    (d) => d.chunks.join("|") !== d.originalChunks.join("|"),
  ).length
  const served = await probe<string>(frame, "reloadSig")
  const outcome = await awaitSave(
    page,
    shortId,
    // Nothing to save shows no Save button: that is the "no request" outcome, not a hang.
    () =>
      page
        .getByTestId("inline-edit-save")
        .click({ timeout: 10_000 })
        .catch(() => {}),
    touched,
  )
  save(label, outcome)
  if (outcome.kind !== "no-request" && Array.isArray(outcome.edits))
    ctx.stats.edits = outcome.edits.length
  if (outcome.kind === "no-request") {
    if (touched)
      ctx.failures.push({
        phase: "edit",
        oracle: "save",
        signature: `edits on the page were never saved${outcome.toasts.length ? `: ${genericize(outcome.toasts.join(" / "))}` : ""}`,
        message: `the page changed (${dom.filter((d) => d.touched).length} slide(s)) but no save request was sent; toasts: ${outcome.toasts.join(" / ") || "none"}`,
      })
    const after = await contentOf(page, shortId)
    if (after !== before)
      ctx.failures.push({
        phase: "edit",
        oracle: "minimal-diff",
        signature: "source changed without a save",
        message: "stored source changed although nothing was sent",
      })
    return false
  }
  if (outcome.kind === "error") {
    const down = outcome.status >= 500
    ctx.failures.push({
      phase: "edit",
      oracle: down ? "harness" : "save",
      signature: down
        ? `environment: API unavailable (HTTP ${outcome.status})`
        : `save refused: ${genericize(outcome.message)}`,
      message: `HTTP ${outcome.status}: ${outcome.message}`,
    })
    return false
  }
  if (outcome.skipped.length)
    ctx.failures.push({
      phase: "edit",
      oracle: "save",
      signature: `partial save skipped edits: ${genericize(outcome.skipped[0]?.message ?? "")}`,
      message: outcome.skipped.map((s) => `#${s.index}: ${s.message}`).join(" / "),
    })
  // The page reloads on the saved source and the session picks back up there.
  await expect
    .poll(async () => probe<string>(await artifactFrame(page), "reloadSig").catch(() => served), {
      timeout: 20_000,
    })
    .not.toBe(served)
    .catch(() => {})
  await expect(page.getByTestId("inline-edit-bar"))
    .toBeVisible({ timeout: 15_000 })
    .catch(() => {
      ctx.failures.push({
        phase: "edit",
        oracle: "save",
        signature: "the session did not pick back up after a successful save",
        message: "inline-edit-bar not visible 15s after the save response",
      })
    })
  const after = await contentOf(page, shortId)
  if (ctx.doc === "markdown") {
    // What a reader gets: the saved Markdown through the served renderer.
    const html = await renderMarkdown(after, null)
    const rendered = await renderTexts(fp.render, html)
    for (const f of [
      ...checkWysiwyg(
        dom.map((d) => d.text),
        rendered,
      ),
      ...checkMarkdownDiff(
        before,
        after,
        dom[0] as DomSlideCapture,
        await renderMarkdown(before, null),
      ),
      ...checkMarkdownHtml(before, after),
      ...checkArtifacts(before, after),
    ])
      ctx.failures.push({ ...f, phase: label })
    save.sources(label, before, after)
    save.dom(dom)
    return ctx.failures.length === failuresBefore
  }
  const rendered = await renderTexts(fp.render, after)
  for (const f of [
    ...checkWysiwyg(
      dom.map((d) => d.text),
      rendered,
    ),
    ...checkEditDiff(before, after, dom),
    ...checkArtifacts(before, after),
  ])
    ctx.failures.push({ ...f, phase: ctx.doc ? label : "edit" })
  save.sources(label, before, after)
  save.dom(dom)
  return ctx.failures.length === failuresBefore
}

type SaveRecorder = ((phase: string, outcome: SaveOutcome) => void) & {
  sources: (phase: string, before: string, after: string) => void
  shot: (name: string, png: Buffer) => void
  dom: (dom: DomSlideCapture[]) => void
}

// ---------------------------------------------------------------------------------
// One session

export async function runSession(
  fp: FuzzPages,
  seed: number,
  opts: SessionOptions,
): Promise<SessionResult> {
  const started = Date.now()
  const { page } = fp
  const rng = new Rng(seed)
  const ctx: Ctx = {
    page,
    rng,
    log: [],
    failures: [],
    slide: 0,
    phase: "edit",
    stats: { touchedSlides: 0, reorderedSlides: 0, edits: 0 },
    doc: isDocMode(opts.mode) ? opts.mode : null,
  }
  const saves: Record<string, unknown> = {}
  const sources: Record<string, { before: string; after: string }> = {}
  const shots: Record<string, Buffer> = {}
  let domCapture: DomSlideCapture[] | null = null
  const recorder = Object.assign(
    (phase: string, outcome: SaveOutcome) => {
      saves[phase] = outcome
    },
    {
      sources: (phase: string, before: string, after: string) => {
        sources[phase] = { before, after }
      },
      shot: (name: string, png: Buffer) => {
        shots[name] = png
      },
      dom: (dom: DomSlideCapture[]) => {
        domCapture = dom
      },
    },
  ) as SaveRecorder
  const oneSlide = (opts.mode ?? "one-slide") === "one-slide"
  const arranged =
    opts.arrange === "on"
      ? true
      : opts.arrange === "off" || oneSlide || ctx.doc
        ? false
        : rng.chance(0.3)
  let shortId = ""
  // What else happened to the page during the session, to tell a product reload
  // (the frame swapped under the editor) from environment noise (the dev servers
  // hot-reloading while other work edits the tree).
  const events: string[] = []
  const onNav = (f: Frame) => {
    if (f === page.mainFrame()) events.push(`page navigated: ${f.url()}`)
    else if (f.parentFrame() === page.mainFrame())
      events.push(`frame navigated: ${f.url().slice(0, 80)}`)
  }
  const onConsole = (m: { text: () => string }) => {
    const t = m.text()
    if (/\[vite\]/.test(t) && !/connect/.test(t)) events.push(`vite: ${t.slice(0, 120)}`)
  }
  let armed = false
  const onNavArmed = (f: Frame) => armed && onNav(f)
  page.on("framenavigated", onNavArmed)
  page.on("console", onConsole)
  try {
    if (ctx.doc) {
      // A document: one section, 8–15 changes and a save, then 5 more and a save.
      const fx = DOC_FIXTURES[ctx.doc]
      shortId = await publishArtifact(page, fx.name, fx.src, fx.mime)
      await openDoc(page, shortId)
      armed = true
      const frame = await artifactFrame(page)
      const section = rng.int(0, (await probe<number>(frame, "sectionCount")) - 1)
      const first = await probe<string>(frame, "reloadSig")
      if (
        await editPhase(ctx, fp, shortId, opts, recorder, {
          slide: section,
          actions: rng.int(8, 15),
          label: "edit",
        })
      ) {
        await expect
          .poll(
            async () => probe<string>(await artifactFrame(page), "reloadSig").catch(() => first),
            { timeout: 20_000 },
          )
          .not.toBe(first)
        await editPhase(ctx, fp, shortId, opts, recorder, {
          slide: section,
          actions: 5,
          label: "edit2",
        })
      }
    } else {
      shortId = await publishArtifact(page, "deck.html", FIXTURE, "text/html")
      await openDeck(page, shortId)
      await expect(page.getByTestId("deck-position")).toBeVisible()
      armed = true
      if (arranged) await arrangePhase(ctx, fp, shortId, recorder)
      if (ctx.failures.some((f) => f.oracle === "arrange-model" || f.oracle === "save")) {
        // The arrangement already failed; there is nothing sound to edit on top of.
      } else if (!oneSlide) await editPhase(ctx, fp, shortId, opts, recorder)
      else {
        const frame = await artifactFrame(page)
        const slide = rng.int(0, (await probe<number>(frame, "slideCount")) - 1)
        const first = await probe<string | null>(frame, "srcSha")
        const round = { slide, actions: rng.int(8, 15), label: "edit" }
        // Round two starts on the page the first save reloaded (fresh source ids).
        if (await editPhase(ctx, fp, shortId, opts, recorder, round)) {
          await expect
            .poll(
              async () =>
                probe<string | null>(await artifactFrame(page), "srcSha").catch(() => first),
              {
                timeout: 20_000,
              },
            )
            .not.toBe(first)
          await editPhase(ctx, fp, shortId, opts, recorder, {
            slide,
            actions: rng.int(5, 8),
            label: "edit2",
          })
        }
      }
    }
  } catch (err) {
    const message = stripAnsi(
      err instanceof Error ? (err.message.split("\n")[0] ?? String(err)) : String(err),
    )
    const toasts = await page
      .locator("[data-sonner-toast]")
      .allInnerTexts()
      .catch(() => [] as string[])
    const env = events.some((e) => e.startsWith("vite") || e.startsWith("page navigated"))
    const discarded = toasts.some((t) => /unsaved inline edits were discarded/.test(t))
    const reloaded = /frame reloaded|Frame was detached|frame not found/.test(message)
    ctx.failures.push({
      phase: ctx.phase,
      oracle: discarded ? "save" : "harness",
      signature: discarded
        ? "the frame reloaded mid-edit and discarded unsaved edits"
        : env
          ? "environment: the app hot-reloaded during the session"
          : reloaded
            ? "the artifact frame reloaded mid-edit"
            : `harness error: ${genericize(message).slice(0, 90)}`,
      message: [
        stripAnsi(err instanceof Error ? (err.stack ?? err.message).slice(0, 1500) : String(err)),
        `events: ${events.join(" / ") || "none"}`,
        `toasts: ${toasts.join(" / ") || "none"}`,
      ].join("\n"),
    })
  } finally {
    page.off("framenavigated", onNavArmed)
    page.off("console", onConsole)
  }
  const result: SessionResult = {
    seed,
    ok: ctx.failures.length === 0,
    failures: ctx.failures,
    actions: ctx.log,
    actionTypes: [...new Set(ctx.log.map((a) => a.type))],
    editActions: ctx.log.filter((a) => a.phase === "edit" && a.type !== "switchSlide").length,
    arranged,
    stats: ctx.stats,
    ms: Date.now() - started,
  }
  mkdirSync(resultsDir(opts.outDir), { recursive: true })
  writeFileSync(join(resultsDir(opts.outDir), `${seed}.json`), JSON.stringify(result, null, 2))
  if (!result.ok) {
    const dir = join(opts.outDir, String(seed))
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "session.json"),
      JSON.stringify(
        {
          ...result,
          shortId,
          replay: `FUZZ_SEED=${seed} pnpm --filter @derive/web test:fuzz`,
          saves,
        },
        null,
        2,
      ),
    )
    const excerpts: string[] = []
    for (const f of result.failures)
      excerpts.push(
        `[${f.phase}] ${f.oracle} — ${f.signature}\n${f.message}${f.excerpt ? `\n${f.excerpt}` : ""}\n`,
      )
    writeFileSync(join(dir, "failures.txt"), excerpts.join("\n"))
    for (const [phase, s] of Object.entries(sources)) {
      writeFileSync(join(dir, `${phase}-before.html`), s.before)
      writeFileSync(join(dir, `${phase}-after.html`), s.after)
    }
    if (domCapture) writeFileSync(join(dir, "edited-dom.json"), JSON.stringify(domCapture, null, 2))
    for (const [name, png] of Object.entries(shots)) writeFileSync(join(dir, `${name}.png`), png)
    await page
      .screenshot()
      .then((png) => writeFileSync(join(dir, "after.png"), png))
      .catch(() => {})
  }
  return result
}

/** Seeds for this run: FUZZ_SEED replays one; otherwise FUZZ_SESSIONS from FUZZ_BASE_SEED. */
export function fuzzSeeds(env = process.env): number[] {
  if (env.FUZZ_SEED) return env.FUZZ_SEED.split(",").map((s) => Number(s.trim()))
  const count = Number(env.FUZZ_SESSIONS ?? 50)
  const base = Number(env.FUZZ_BASE_SEED ?? 1)
  return Array.from({ length: count }, (_, i) => base + i)
}
