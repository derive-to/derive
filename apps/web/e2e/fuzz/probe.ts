/**
 * In-page probe for the editing fuzz harness. `installProbe` is serialized into the
 * artifact frame (and into the page that renders a saved source), so it must stay
 * self-contained: no imports, no references to module scope.
 *
 * It answers three kinds of question without mutating the document:
 *  - what text a person sees on each slide (tag-based line breaks, editor chrome
 *    skipped, whitespace collapsed) — the WYSIWYG oracle compares these;
 *  - which elements an edit session actually changed, relative to a snapshot taken
 *    at the start of the session — the minimal-diff oracle turns those into the only
 *    source byte ranges allowed to change;
 *  - where on screen there is text, empty space, or a structural node to aim at.
 *
 * A page with no `[data-derive-slide]` (an HTML article, a rendered Markdown doc) is
 * one "slide": its <main> (else <body>). Its sections — each sectioning child of the
 * root, or else the run of blocks from one h1/h2 to the next — play the part a deck's
 * slides play for aiming: `show(i)` scrolls section i to the top and scopes `targets`
 * to it.
 */

export type Rect = { x: number; y: number; w: number; h: number }

export interface DomSlideCapture {
  region: string | null
  text: string
  /** Chunk keys of the slide's children, in the order the edited DOM shows them. */
  chunks: string[]
  /** Chunk keys at the session snapshot (the source's order before the save). */
  originalChunks: string[]
  /** Per original chunk key: element paths (relative to that chunk) of the elements
   *  whose own content (attributes, text, which children) changed. [] means the chunk
   *  root itself. */
  changed: Record<string, number[][]>
  touched: boolean
}

export interface ProbeTargets {
  view: { w: number; h: number }
  slideRect: Rect | null
  /** Text glyph boxes on the visible slide, in frame viewport coordinates, with the
   *  nearest text block that holds them (li, td, p, h2 …). */
  text: { rect: Rect; label: string; block: string }[]
  /** Points on the slide at least 10px from any glyph box. */
  empty: { x: number; y: number }[]
  /** Structural nodes on the visible slide, each with a point inside it away from text. */
  nodes: { id: string; rect: Rect; grab: { x: number; y: number } | null }[]
  /** Repeated siblings (look-alike cards, items, columns) on the visible slide: movable
   *  with no author markup. Each with a point inside it away from text. */
  repeats: { label: string; rect: Rect; grab: { x: number; y: number } | null }[]
}

export function installProbe(): void {
  type W = Window & { __fuzz?: unknown }
  const w = window as W
  if (w.__fuzz) return

  const BLOCK = new Set(
    "address article aside blockquote dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr li main nav ol p pre section summary table tbody thead tfoot tr td th ul caption".split(
      " ",
    ),
  )
  const SKIP = new Set(["script", "style", "template", "noscript"])
  const DROP_ATTRS = new Set([
    "contenteditable",
    "spellcheck",
    "tabindex",
    "data-interaction-state",
    "data-derive-editable",
    "data-derive-readonly",
    "data-derive-mention",
    "data-derive-mention-new",
  ])

  const isUi = (el: Element): boolean =>
    el.classList.contains("derive-edit-ui") ||
    el.classList.contains("derive-el-hl") ||
    el.classList.contains("derive-el-badge")
  const isHold = (el: Element): boolean =>
    el.localName === "br" && el.hasAttribute("data-derive-hold")

  const deckSlides = (): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-derive-slide]")).filter(
      (el) => !el.parentElement?.closest("[data-derive-slide]"),
    )
  const docRoot = (): HTMLElement => document.querySelector("main") ?? document.body
  const isDoc = (): boolean => deckSlides().length === 0
  const topSlides = (): HTMLElement[] => (isDoc() ? [docRoot()] : deckSlides())
  const kids = (el: Element): Element[] =>
    Array.from(el.children).filter((c) => !isUi(c) && !isHold(c))
  const SECTIONING = new Set(["section", "header", "footer", "article", "aside", "nav"])
  /** A doc's sections: each sectioning child of the root, or runs split at h1/h2. */
  const sections = (): Element[][] => {
    const all = kids(docRoot())
    if (all.length && all.every((k) => SECTIONING.has(k.localName))) return all.map((k) => [k])
    const out: Element[][] = []
    for (const k of all) {
      if (!out.length || /^h[12]$/.test(k.localName)) out.push([])
      ;(out[out.length - 1] as Element[]).push(k)
    }
    return out
  }
  let scope: Element[] | null = null

  const classKey = (el: Element): string =>
    Array.from(el.classList)
      .filter((c) => c && !c.startsWith("derive-"))
      .sort()
      .join(".")
  const chunkKeys = (els: Element[]): string[] => {
    const seen = new Map<string, number>()
    return els.map((el) => {
      const id = el.getAttribute("data-derive-node")
      if (id !== null) return `node:${id}`
      const base = `${el.localName}.${classKey(el)}`
      const k = seen.get(base) ?? 0
      seen.set(base, k + 1)
      return `${base}#${k}`
    })
  }

  const norm = (s: string): string =>
    s
      .replace(/[\u00a0\u2007\u202f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  const textOf = (root: Element): string => {
    const out: string[] = []
    const walk = (node: Node, depth: number) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) out.push((child as Text).data)
        else if (child.nodeType === 1) {
          const el = child as Element
          if (isUi(el) || isHold(el) || SKIP.has(el.localName)) continue
          if (el.localName === "br") {
            out.push("\n")
            continue
          }
          const block = depth === 0 || BLOCK.has(el.localName)
          if (block) out.push("\n")
          walk(el, depth + 1)
          if (block) out.push("\n")
        }
      }
    }
    walk(root, 0)
    return norm(out.join(""))
  }

  /** An element's attributes as source would carry them, minus what edit mode adds. */
  const attrsOf = (el: Element): string => {
    const attrs: string[] = []
    for (const a of Array.from(el.attributes)) {
      if (DROP_ATTRS.has(a.name) || a.name.startsWith("data-derive-runtime")) continue
      if (a.name === "class") {
        let v = classKey(el)
        if (el.hasAttribute("data-derive-slide")) v = v.replace(/(^|\.)on(?=\.|$)/, "")
        if (v) attrs.push(`class=${v}`)
        continue
      }
      attrs.push(`${a.name}=${JSON.stringify(a.value)}`)
    }
    return attrs.sort().join(" ")
  }
  /** What an element itself holds: its attributes, its text, and which elements sit
   *  among its children (by identity, not content). A change deeper down leaves its
   *  ancestors' own content alone, so the oracle blames only the elements that
   *  actually changed — including an ancestor whose own text changed as well. */
  const ownOf = (el: Element, ids: Map<Element, number>): string => {
    let out = `${attrsOf(el)}|`
    let text = ""
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) text += (child as Text).data
      else if (child.nodeType === 1) {
        const c = child as Element
        if (isUi(c) || isHold(c)) continue
        out += `${JSON.stringify(text)}<${c.localName}#${ids.get(c) ?? "new"}>`
        text = ""
      }
    }
    return out + JSON.stringify(text)
  }

  type Orig = { el: Element; slide: number; chunkKey: string; path: number[]; own: string }
  let orig: Orig[] = []
  let ids = new Map<Element, number>()
  let origChunks: string[][] = []
  let token = ""

  const snapshot = (): string => {
    orig = []
    origChunks = []
    ids = new Map()
    for (const [i, el] of Array.from(document.querySelectorAll("*")).entries()) ids.set(el, i)
    topSlides().forEach((slide, s) => {
      const chunks = kids(slide)
      const keys = chunkKeys(chunks)
      origChunks.push(keys)
      chunks.forEach((chunk, ci) => {
        const visit = (el: Element, path: number[]) => {
          orig.push({ el, slide: s, chunkKey: keys[ci] as string, path, own: ownOf(el, ids) })
          for (const [i, k] of kids(el).entries()) visit(k, [...path, i])
        }
        visit(chunk, [])
      })
    })
    token = Math.random().toString(36).slice(2)
    return token
  }

  const capture = (expectToken: string): DomSlideCapture[] => {
    if (!token || token !== expectToken)
      throw new Error("probe snapshot lost: the frame reloaded during the edit session")
    const slides = topSlides()
    return slides.map((slide, s) => {
      const chunks = chunkKeys(kids(slide))
      const originalChunks = origChunks[s] ?? []
      const changedEntries = orig.filter(
        (o) =>
          o.slide === s &&
          (!o.el.isConnected || !slide.contains(o.el) || ownOf(o.el, ids) !== o.own),
      )
      const changed: Record<string, number[][]> = {}
      for (const o of changedEntries) {
        const list = changed[o.chunkKey] ?? []
        list.push(o.path)
        changed[o.chunkKey] = list
      }
      const touched = changedEntries.length > 0 || chunks.join("|") !== originalChunks.join("|")
      return {
        region: slide.getAttribute("data-derive-region"),
        text: textOf(slide),
        chunks,
        originalChunks,
        changed,
        touched,
      }
    })
  }

  const rectOf = (r: DOMRect): Rect => ({ x: r.left, y: r.top, w: r.width, h: r.height })
  const visibleSlide = (): HTMLElement | null =>
    isDoc()
      ? docRoot()
      : (topSlides().find((s) => {
          const r = s.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }) ?? null)

  const TEXT_BLOCK = "li,td,th,h1,h2,h3,h4,h5,h6,p,blockquote,figcaption,pre,dt,dd,caption"
  const glyphRects = (root: Element): { rect: Rect; label: string; block: string }[] => {
    const out: { rect: Rect; label: string; block: string }[] = []
    const vw = window.innerWidth
    const vh = window.innerHeight
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text
      if (!t.data.trim()) continue
      const parent = t.parentElement
      if (!parent || parent.closest(".derive-edit-ui")) continue
      const range = document.createRange()
      range.selectNodeContents(t)
      for (const r of Array.from(range.getClientRects())) {
        if (r.width < 3 || r.height < 3) continue
        if (r.left < 2 || r.top < 2 || r.right > vw - 2 || r.bottom > vh - 2) continue
        out.push({
          rect: rectOf(r),
          label: `${parent.localName}${parent.className ? `.${String(parent.className).split(" ")[0]}` : ""}:${t.data.trim().slice(0, 24)}`,
          block: parent.closest(TEXT_BLOCK)?.localName ?? "",
        })
      }
    }
    return out
  }

  const farFromText = (x: number, y: number, rects: Rect[], gap: number) =>
    rects.every((r) => x < r.x - gap || x > r.x + r.w + gap || y < r.y - gap || y > r.y + r.h + gap)

  const targets = (seed: number): ProbeTargets => {
    let s = seed >>> 0 || 1
    const rand = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      return s / 4294967296
    }
    const view = { w: window.innerWidth, h: window.innerHeight }
    const slide = visibleSlide()
    if (!slide) return { view, slideRect: null, text: [], empty: [], nodes: [], repeats: [] }
    // A doc aims inside its current section only: the section's box stands in for the
    // slide's, and only its words are targets.
    const scoped = isDoc() && scope ? scope.filter((el) => el.isConnected) : null
    const unionRect = (els: Element[]) => {
      const rs = els.map((el) => el.getBoundingClientRect())
      const left = Math.min(...rs.map((r) => r.left))
      const top = Math.min(...rs.map((r) => r.top))
      return new DOMRect(
        left,
        top,
        Math.max(...rs.map((r) => r.right)) - left,
        Math.max(...rs.map((r) => r.bottom)) - top,
      )
    }
    const sr = scoped?.length ? unionRect(scoped) : slide.getBoundingClientRect()
    const text = scoped ? scoped.flatMap((el) => glyphRects(el)) : glyphRects(slide)
    const inScope = (el: Element) => !scoped || scoped.some((s) => s.contains(el))
    const boxes = text.map((t) => t.rect)
    const empty: { x: number; y: number }[] = []
    const x0 = Math.max(4, sr.left)
    const y0 = Math.max(4, sr.top)
    const x1 = Math.min(view.w - 4, sr.right)
    const y1 = Math.min(view.h - 4, sr.bottom)
    for (let i = 0; i < 400 && empty.length < 24; i++) {
      const x = x0 + rand() * (x1 - x0)
      const y = y0 + rand() * (y1 - y0)
      if (farFromText(x, y, boxes, 10)) empty.push({ x, y })
    }
    const grabIn = (el: Element) => {
      const r = el.getBoundingClientRect()
      for (let i = 0; i < 80; i++) {
        const x = r.left + 2 + rand() * Math.max(0, r.width - 4)
        const y = r.top + 2 + rand() * Math.max(0, r.height - 4)
        if (x < 2 || y < 2 || x > view.w - 2 || y > view.h - 2) continue
        if (!farFromText(x, y, boxes, 6)) continue
        const hit = document.elementFromPoint(x, y)
        if (hit && el.contains(hit)) return { x, y }
      }
      return null
    }
    const nodes = Array.from(
      slide.querySelectorAll<HTMLElement>("[data-derive-region] > [data-derive-node]"),
    ).map((el) => ({
      id: el.getAttribute("data-derive-node") ?? "",
      rect: rectOf(el.getBoundingClientRect()),
      grab: grabIn(el),
    }))
    const sig = (el: Element) => `${el.localName}.${classKey(el)}`
    const repeats = Array.from(slide.querySelectorAll<HTMLElement>("[data-derive-src]"))
      .filter((el) => {
        if (!inScope(el)) return false
        const parent = el.parentElement
        if (!parent?.hasAttribute("data-derive-src") || el.hasAttribute("data-derive-node"))
          return false
        if (/^(?:p|h[1-6]|blockquote|pre|figcaption|dd|dt|td|th)$/.test(el.localName)) return false
        const d = getComputedStyle(el).display
        if (!/^(?:block|flex|grid|list-item|table|table-row|flow-root)$/.test(d)) return false
        const r = el.getBoundingClientRect()
        if (!(r.width > 8 && r.height > 8)) return false
        return (
          Array.from(parent.children).filter(
            (c) => c.hasAttribute("data-derive-src") && sig(c) === sig(el),
          ).length > 1
        )
      })
      .map((el) => ({
        label: `${sig(el)}:${(el.textContent ?? "").trim().slice(0, 24)}`,
        rect: rectOf(el.getBoundingClientRect()),
        grab: grabIn(el),
      }))
    return { view, slideRect: rectOf(sr), text, empty, nodes, repeats }
  }

  /** An element's box grown to cover its own content, which may overflow it. */
  const extentOf = (el: Element): Rect => {
    const r = el.getBoundingClientRect()
    let x0 = r.left
    let y0 = r.top
    let x1 = r.right
    let y1 = r.bottom
    const range = document.createRange()
    range.selectNodeContents(el)
    for (const c of Array.from(range.getClientRects())) {
      if (!c.width && !c.height) continue
      x0 = Math.min(x0, c.left)
      y0 = Math.min(y0, c.top)
      x1 = Math.max(x1, c.right)
      y1 = Math.max(y1, c.bottom)
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }

  /* Leak detection: which blocks' text changed since `mark`. */
  let marked = new Map<Element, { text: string; parent: Element | null }>()
  const directText = (el: Element) => {
    let t = ""
    for (const c of Array.from(el.childNodes))
      if (c.nodeType === 3) t += (c as Text).data
      else if (c.nodeType === 1 && !isUi(c as Element)) t += `<${(c as Element).localName}>`
    return t
  }
  let pointEl: Element | null = null
  let pointParents = new Map<Element, Element | null>()
  const mark = (x?: number, y?: number) => {
    pointEl = null
    pointParents = new Map()
    if (x !== undefined && y !== undefined) {
      const node = document.caretRangeFromPoint?.(x, y)?.startContainer
      pointEl = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null
      const hit = document.elementFromPoint(x, y)
      // Only trust the caret position when it is really under the point (a caret
      // range snaps to the nearest text even from empty space).
      if (pointEl && hit && !hit.contains(pointEl) && !pointEl.contains(hit)) pointEl = hit
      pointEl ??= hit
      for (let e = pointEl; e; e = e.parentElement) pointParents.set(e, e.parentElement)
    }
    marked = new Map()
    for (const slide of topSlides())
      for (const el of [slide, ...Array.from(slide.querySelectorAll("*"))])
        if (!isUi(el) && !el.closest(".derive-edit-ui"))
          marked.set(el, { text: directText(el), parent: el.parentElement })
  }
  /** `b` is the next words after `a`: nothing but whitespace between them. */
  const followsDirectly = (a: Element, b: Element): boolean => {
    if (a.contains(b) || !(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING))
      return false
    const between = document.createRange()
    between.setStartAfter(a)
    between.setEndBefore(b)
    return !between.toString().trim()
  }
  /** `next`: Enter at a heading's end moves the caret on to the words after it, so the
   *  block right after the clicked one counts as where the typing went. */
  const changedBlocks = (next = false): { rect: Rect; label: string; atPoint: boolean }[] => {
    const hits = new Set<Element>()
    for (const [el, was] of marked) {
      if (!el.isConnected) {
        if (was.parent?.isConnected) hits.add(was.parent)
      } else if (directText(el) !== was.text) hits.add(el)
    }
    for (const slide of topSlides())
      for (const el of Array.from(slide.querySelectorAll("*")))
        if (!marked.has(el) && !el.closest(".derive-edit-ui") && el.parentElement)
          hits.add(el.parentElement)
    return Array.from(hits).map((el) => {
      const block = (el.closest("[data-derive-editable]") as Element | null) ?? el
      // The clicked element may itself be gone (a delete run removed it): its nearest
      // surviving ancestor is where the edit happened.
      let at: Element | null = pointEl
      while (at && !at.isConnected) at = pointParents.get(at) ?? null
      const pointBlock = at ? at.closest("[data-derive-editable]") : null
      return {
        atPoint:
          !!pointBlock && (pointBlock === block || (next && followsDirectly(pointBlock, block))),
        rect: extentOf(block),
        label: `${block.localName}.${classKey(block)}:${(block.textContent ?? "").trim().slice(0, 40)}`,
      }
    })
  }
  const activeBlock = (): { rect: Rect; label: string } | null => {
    const a = document.activeElement
    const block = a?.closest?.("[data-derive-editable]")
    if (!block) return null
    return {
      rect: extentOf(block),
      label: `${block.localName}.${classKey(block)}:${(block.textContent ?? "").trim().slice(0, 40)}`,
    }
  }

  const show = (index: number) => {
    if (isDoc()) {
      // Scroll the section's top to the top of the frame, and aim inside it from now on.
      scope = sections()[index] ?? null
      const first = scope?.[0]
      if (first) {
        const top = first.getBoundingClientRect().top + window.scrollY - 8
        window.scrollTo({ top: Math.max(0, top), behavior: "instant" as ScrollBehavior })
      }
      return
    }
    topSlides().forEach((slide, i) => {
      slide.classList.toggle("on", i === index)
    })
  }
  const sectionCount = () => (isDoc() ? sections().length : topSlides().length)
  /** Changes whenever the frame reloads: the stamped source sha where there is one,
   *  else an id this probe drew when it was installed in this document. */
  const fid = Math.random().toString(36).slice(2)
  const reloadSig = () => document.documentElement.getAttribute("data-derive-src-sha") ?? fid
  const scrollY = () => window.scrollY

  const texts = (): string[] => topSlides().map((s) => textOf(s))
  const outlines = (): string[] => {
    const o = (el: Element): string => `${el.localName}(${kids(el).map(o).join(",")})`
    return topSlides().map(o)
  }
  /** The block actions pill is up (a block is selected and nothing is typing). */
  const pill = (): boolean => {
    const bar = document.querySelector<HTMLElement>(".derive-block-pill")
    if (!bar) return false
    const r = bar.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && getComputedStyle(bar).display !== "none"
  }
  /** The pill's name: the selected block's drag handle. */
  const grip = (): Rect | null => {
    const g = document.querySelector<HTMLElement>(".derive-block-name")
    if (!g) return null
    const r = g.getBoundingClientRect()
    return r.width > 0 && r.height > 0 ? rectOf(r) : null
  }
  /** Where the selected block's siblings are (the selection box names the block). */
  const siblingRects = (): Rect[] => {
    const box = document.querySelector<HTMLElement>(".derive-block-box")?.getBoundingClientRect()
    if (!box || !box.width) return []
    const near = (a: DOMRect) =>
      Math.abs(a.left - box.left) < 1.5 &&
      Math.abs(a.top - box.top) < 1.5 &&
      Math.abs(a.width - box.width) < 1.5
    const el = Array.from(document.querySelectorAll("[data-derive-src]")).find((e) =>
      near(e.getBoundingClientRect()),
    )
    const parent = el?.parentElement
    if (!el || !parent) return []
    const same = (c: Element) =>
      el.hasAttribute("data-derive-node")
        ? c.hasAttribute("data-derive-node")
        : c.localName === el.localName && classKey(c) === classKey(el)
    return Array.from(parent.children)
      .filter((c) => c !== el && same(c))
      .map((c) => rectOf(c.getBoundingClientRect()))
  }
  const nodeRect = (id: string): Rect | null => {
    const el = document.querySelector(`[data-derive-node="${CSS.escape(id)}"]`)
    return el ? rectOf(el.getBoundingClientRect()) : null
  }
  /** Is the text under this point already in an armed (editable) block? */
  const armedAt = (x: number, y: number): boolean => {
    const range = document.caretRangeFromPoint?.(x, y)
    const node = range?.startContainer
    const el = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null
    return !!el?.closest("[data-derive-editable]")
  }
  const slideCount = () => topSlides().length
  /** The stored source this page was served from (stamped for editors). */
  const srcSha = () => document.documentElement.getAttribute("data-derive-src-sha")
  /** An enabled, visible structural resize handle, by class. */
  const handle = (cls: string): Rect | null => {
    const el = document.querySelector<HTMLButtonElement>(`.${cls}`)
    if (!el || el.disabled) return null
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"
      ? rectOf(r)
      : null
  }
  /** Where the visible slide sits right now: equal twice in a row means settled. */
  const layoutSig = () => {
    const r = visibleSlide()?.getBoundingClientRect()
    return `${window.scrollX},${window.scrollY},${r?.x},${r?.y},${r?.width},${r?.height}`
  }
  const visibleIndex = () => {
    const v = visibleSlide()
    return v ? topSlides().indexOf(v) : -1
  }

  w.__fuzz = {
    snapshot,
    capture,
    texts,
    outlines,
    targets,
    mark,
    changedBlocks,
    activeBlock,
    show,
    pill,
    grip,
    siblingRects,
    nodeRect,
    armedAt,
    slideCount,
    srcSha,
    handle,
    layoutSig,
    visibleIndex,
    sectionCount,
    reloadSig,
    scrollY,
  }
}
