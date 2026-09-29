/**
 * The frame half of live saving: bringing the page in line with a newer version of its
 * source IN PLACE, so a save (yours or someone else's) never reloads the document.
 *
 * Source ids are positions in the stored source, so a save renumbers every element after
 * the first thing it changed. The server answers a sync (see the contract in
 * apps/web/src/api.ts `syncArtifact`) with `remap[oldId] → newId` for every element it
 * kept, and `patches`: the new stamped markup of each changed subtree, by the old id of
 * its root. This module is what the page does with that answer:
 *
 *  - Your own save: the page already shows what was saved, so nothing is replaced. The
 *    save's collect recorded the new page in source order by the page element that
 *    produced each of its elements (`layoutOf`); the sync describes the new page's ids in
 *    that same order (`newPageOf`), so the two line up one for one. An editor span the
 *    save wrote as a real tag (`<b>`) becomes that tag, words and caret untouched
 *    (`adopt`).
 *  - Someone else's save: a changed subtree is swapped for the patch (the caller decides
 *    when: never under the caret, never over unsaved typing).
 *  - Everything else just takes its new id (`renumber`); an element the new version no
 *    longer has is marked stale, so nothing can save through a number that now names a
 *    different element.
 *
 * DOM-agnostic like source-tokens (only the nodes passed in). Frame-only: not exported
 * from the package index.
 */

import {
  type Baseline,
  CHROME,
  FMT_ATTR,
  GEN_ATTR,
  HOLD_ATTR,
  HREF_ATTR,
  type SigParts,
  SRC_ATTR,
  sigParts,
  srcOf,
} from "./source-tokens"

/** An element the current version no longer has: a save naming it is refused here. */
export const STALE_ATTR = "data-derive-stale"

export interface SyncPatch {
  old: number
  html: string
}
export interface SyncReply {
  version: number
  sha: string
  hashes: string[]
  remap: number[]
  patches: SyncPatch[]
  head: boolean
}

/** A patch's markup as one element, parsed where it will live (`at`, the element it
 *  replaces) so a row or an item parses as one. A `<body>` needs a whole document. */
export function patchRoot(html: string, doc: Document, at?: Element): Element | null {
  if (/^\s*<body[\s>]/i.test(html)) {
    const parsed = new DOMParser().parseFromString(
      `<!doctype html><html>${html}</html>`,
      "text/html",
    )
    return doc.importNode(parsed.body, true)
  }
  if (at?.parentNode) {
    const range = doc.createRange()
    range.selectNode(at)
    return range.createContextualFragment(html).firstElementChild
  }
  const t = doc.createElement("template")
  t.innerHTML = html
  const el = t.content.firstElementChild
  return el ? doc.importNode(el, true) : null
}

/** An element and its stamped descendants, in document order. */
export const stampedIn = (el: Element): Element[] => [
  ...(srcOf(el) !== null ? [el] : []),
  ...Array.from(el.querySelectorAll(`[${SRC_ATTR}]`)).filter((e) => srcOf(e) !== null),
]

/** An element's tag as a save writes it: the editor's spans as the tags they become,
 *  and the two spellings of bold and italic as one. */
export const tagOf = (el: Element): string => {
  const f = el.getAttribute(FMT_ATTR)
  const t = f === "b" || f === "i" || f === "a" ? f : el.localName
  return t === "strong" ? "b" : t === "em" ? "i" : t
}

/** The body as a save's result will hold it, recorded when the save was collected: every
 *  element of the new page in source order, by the page element that produced it (null:
 *  a line break the save adds, which the page has no element for). Outside the save's
 *  content ops that is the page's own stamped elements in document order. */
export function layoutOf(
  root: Element,
  emit: ReadonlyMap<Element, (Element | null)[]>,
): (Element | null)[] {
  const order: (Element | null)[] = []
  const kids = (el: Element) => {
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (c.matches(CHROME) || c.hasAttribute(GEN_ATTR)) continue
      if (srcOf(c) !== null) visit(c)
      else kids(c)
    }
  }
  const visit = (el: Element) => {
    const list = emit.get(el)
    if (list) order.push(...list)
    else {
      order.push(el)
      kids(el)
    }
  }
  if (srcOf(root) !== null) visit(root)
  else kids(root)
  return order
}

/** One element of the new page: its id and tag, and where it comes from — an element
 *  of the old page the sync kept (`old`), or one of a patch's (`made`, under `root`). */
export interface NewEl {
  id: number
  tag: string
  old: Element | null
  made: Element | null
  root: Element | null
}

/** The new page's stamped elements in document order, as a sync describes it: the old
 *  page's (the baseline's elements, whose ids ascend in document order) with each patch
 *  root's subtree replaced by the patch's elements, and every other element renumbered.
 *  Null when the answer doesn't describe this page. */
export function newPageOf(
  base: Baseline,
  remap: readonly number[],
  roots: ReadonlyMap<number, Element>,
): NewEl[] | null {
  const parent = new Map<Element, Element>()
  for (const [el, parts] of base)
    for (const q of parts) if (typeof q !== "string") parent.set(q, el)
  const within = (el: Element, root: Element) => {
    for (let e = parent.get(el); e; e = parent.get(e)) if (e === root) return true
    return false
  }
  const olds = [...base.keys()]
    .filter((el) => srcOf(el) !== null)
    .sort((a, b) => (srcOf(a) as number) - (srcOf(b) as number))
  const out: NewEl[] = []
  let skip: Element | null = null
  for (const el of olds) {
    if (skip && within(el, skip)) continue
    skip = null
    const o = srcOf(el) as number
    const made = roots.get(o)
    if (made) {
      for (const m of stampedIn(made))
        out.push({ id: srcOf(m) as number, tag: tagOf(m), old: null, made: m, root: made })
      skip = el
      continue
    }
    const n = remap[o] ?? -1
    if (n < 0) return null
    out.push({ id: n, tag: tagOf(el), old: el, made: null, root: null })
  }
  return out
}

/** An element's own words: its text, leaving out the elements of its own that the new
 *  page names (`own`) and the editor's chrome. */
const wordsOf = (el: Element, own: (c: Element) => boolean): string => {
  let out = ""
  const walk = (n: Node) => {
    for (let c = n.firstChild; c; c = c.nextSibling)
      if (c.nodeType === 3) out += (c as Text).data
      else if (c.nodeType === 1 && !own(c as Element) && !(c as Element).matches(CHROME)) walk(c)
  }
  walk(el)
  return out
}

/** An element's children as a save writes them: the editor's chrome and what page
 *  scripts made left out, a mention chip's insides in its place. */
const childrenOf = (el: Element, holds: boolean): Element[] => {
  const out: Element[] = []
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
    if (c.matches(CHROME) || c.hasAttribute(GEN_ATTR)) continue
    // A mention chip, and the editor's line-break span, are transparent: their
    // insides are what a save writes.
    if (c.matches(".derive-mention") || c.getAttribute(FMT_ATTR) === "br")
      out.push(...childrenOf(c, holds))
    else if (holds || !(c.localName === "br" && c.hasAttribute(HOLD_ATTR))) out.push(c)
  }
  return out
}

/** How the recorded layout lines up with the new page: kept elements one for one, and
 *  each changed subtree element for element (`pairs`: the page already shows it), with
 *  the subtrees whose words the new version reads differently (`differ`: it normalized
 *  them), or — where the page shows it with other elements altogether (Markdown renders
 *  typed `**` as bold) — as the page element its new markup replaces (`reshaped`).
 *  Null when they don't line up. */
export function linePage(
  order: readonly (Element | null)[],
  page: readonly NewEl[],
): {
  pairs: [NewEl, Element][]
  differ: [Element, Element][]
  reshaped: [Element, Element][]
  strays: Element[]
  spaced: Element[]
} | null {
  const pairs: [NewEl, Element][] = []
  const differ: [Element, Element][] = []
  const reshaped: [Element, Element][] = []
  // Empty editor elements the save wrote as nothing (a bold with no words in it): the
  // new version doesn't have them, and the page lets them go.
  const strays: Element[] = []
  const spaced: Element[] = []
  const stray = (d: Element | null | undefined) =>
    d === null || (!!d && srcOf(d) === null && !wordsOf(d, () => false).trim())
  // Where the page holds the element the new version keeps: itself, a copy standing in
  // for it (editing can rebuild an inline element with the same attributes), or — where
  // the new version kept a position rather than an element (rows traded places) — an
  // element with the very same opening tag.
  const standsFor = (d: Element | null | undefined, old: Element, tag: string) =>
    !!d && (d === old || (tagOf(d) === tag && (srcOf(d) === srcOf(old) || sameOpening(d, old))))
  let j = 0
  for (let i = 0; i < page.length; ) {
    const ne = page[i] as NewEl
    if (!ne.root) {
      while (
        j < order.length &&
        !standsFor(order[j], ne.old as Element, ne.tag) &&
        stray(order[j])
      ) {
        const d = order[j]
        if (d) strays.push(d)
        j++
      }
      const d = order[j]
      if (!standsFor(d, ne.old as Element, ne.tag)) return null
      pairs.push([ne, d as Element])
      i++
      j++
      continue
    }
    // A run of changed subtrees, up to the next element both sides keep: each subtree
    // in turn, its page element and everything the page holds inside it.
    let k = i
    while (k < page.length && (page[k] as NewEl).root) k++
    for (let g = i; g < k; ) {
      const root = (page[g] as NewEl).root as Element
      let h = g
      while (h < k && (page[h] as NewEl).root === root) h++
      const head = order[j]
      if (!head || tagOf(head) !== tagOf(root)) return null
      let e = j + 1
      while (e < order.length && (order[e] === null || head.contains(order[e] as Element))) e++
      // Down the two trees together: each element with its counterpart, and where the
      // page holds a different set of children, that element takes the new markup
      // (the smallest subtree that differs — never a whole region for one paragraph).
      const made = new Map(page.slice(g, h).map((n) => [n.made as Element, n]))
      const walk = (d: Element, p: Element) => {
        const ne = made.get(p)
        if (!ne) return
        const pk = Array.from(p.children)
        const fits = (list: Element[]) =>
          list.length === pk.length && list.every((c, x) => tagOf(c) === tagOf(pk[x] as Element))
        // A line-holding break is saved only while it holds a line: try the page's
        // children with and without them.
        const dk = [childrenOf(d, true), childrenOf(d, false)].find(fits)
        if (!dk) {
          reshaped.push([d, p])
          return
        }
        pairs.push([ne, d])
        const own = (c: Element) => dk.includes(c)
        const mine = wordsOf(d, own)
        const theirs = wordsOf(p, (c) => pk.includes(c))
        // Only the space between its children differs (how the markup was laid out, not
        // what it says): the page keeps its own, and the baseline takes it as saved.
        if (mine !== theirs) {
          if (mine.replace(/\s+/g, " ").trim() === theirs.replace(/\s+/g, " ").trim())
            spaced.push(d)
          else differ.push([d, p])
        }
        dk.forEach((c, x) => {
          walk(c, pk[x] as Element)
        })
      }
      walk(head, root)
      g = h
      j = e
    }
    i = k
  }
  while (j < order.length && stray(order[j])) {
    const d = order[j]
    if (d) strays.push(d)
    j++
  }
  return j === order.length ? { pairs, differ, reshaped, strays, spaced } : null
}

/** An element's opening tag as the source has it (the editor's own attributes aside). */
const EDITOR_ATTRS =
  /^(?:data-derive-(?:src|editable|generated|stale|fmt|href|hold)|contenteditable|class|style)$/
export const openingOf = (el: Element): string =>
  `${el.localName} ${Array.from(el.attributes)
    .filter((x) => !EDITOR_ATTRS.test(x.name))
    .map((x) => `${x.name}=${x.value}`)
    .sort()
    .join("\u0000")}`
const sameOpening = (a: Element, b: Element): boolean => openingOf(a) === openingOf(b)

/** Run `fn` (which moves nodes) without losing the caret: the text nodes it sits in are
 *  moved, not rebuilt, so the same points are valid afterwards. */
export function keepingSelection(doc: Document, fn: (swap: Map<Node, Node>) => void): void {
  const sel = doc.getSelection()
  const saved =
    sel && sel.rangeCount > 0
      ? ([sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset] as const)
      : null
  const swap = new Map<Node, Node>()
  fn(swap)
  if (!saved || !sel) return
  const [an, ao, fnode, fo] = saved
  const a = (an && swap.get(an)) ?? an
  const f = (fnode && swap.get(fnode)) ?? fnode
  if (!a?.isConnected || !f?.isConnected) return
  try {
    sel.setBaseAndExtent(a, ao, f, fo)
  } catch {
    /* the caret's node changed shape; the selection stays where the browser put it */
  }
}

/** Give a saved element its new identity from the patch. The same element kind takes the
 *  new attributes in place (its runtime classes and inline style stay the page's); an
 *  editor span the save wrote as a tag becomes that tag, keeping its words. */
export function adopt(d: Element, p: Element, swap: Map<Node, Node>): Element {
  if (d.localName === p.localName && !d.hasAttribute(FMT_ATTR)) {
    for (const a of Array.from(p.attributes))
      if (a.name !== "class" && a.name !== "style" && d.getAttribute(a.name) !== a.value)
        d.setAttribute(a.name, a.value)
    d.removeAttribute(HOLD_ATTR)
    return d
  }
  const el = d.ownerDocument.createElement(p.localName)
  for (const a of Array.from(p.attributes)) el.setAttribute(a.name, a.value)
  el.append(...Array.from(d.childNodes))
  d.replaceWith(el)
  swap.set(d, el)
  return el
}

/** A patch element's children as baseline parts, its stamped children named by the page
 *  elements that stand for them. */
export function partsVia(p: Element, pageOf: (patchEl: Element) => Element | undefined): SigParts {
  return sigParts(p).map((part) => (typeof part === "string" ? part : (pageOf(part) ?? part)))
}

/** Give an element its new id, or mark it stale. A stale inline tag goes back to being
 *  editor formatting (it saves as the tag it is); anything bigger refuses to save. */
export function renumber(el: Element, id: number | null): void {
  if (id !== null) {
    el.setAttribute(SRC_ATTR, String(id))
    return
  }
  el.removeAttribute(SRC_ATTR)
  if (/^(?:b|strong|i|em|br)$/.test(el.localName)) return
  if (el.localName === "a") {
    el.setAttribute(FMT_ATTR, "a")
    el.setAttribute(HREF_ATTR, el.getAttribute("href") ?? "")
    return
  }
  el.setAttribute(STALE_ATTR, "")
}

/** The same renumbering over markup kept as a string (undo history, a block's words at
 *  the start of the session). */
export function renumberHtml(
  html: string,
  doc: Document,
  idFor: (old: number) => number | null,
): string {
  if (!html.includes(SRC_ATTR)) return html
  const t = doc.createElement("template")
  t.innerHTML = html
  for (const el of Array.from(t.content.querySelectorAll(`[${SRC_ATTR}]`))) {
    const n = srcOf(el)
    if (n !== null) renumber(el, idFor(n))
  }
  return t.innerHTML
}
