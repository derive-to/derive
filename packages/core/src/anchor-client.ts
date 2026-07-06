/**
 * The comment-anchor client that runs INSIDE the sandboxed artifact iframe.
 *
 * This is real, type-checked source — bundled by scripts/build-anchor-client.mjs into a
 * self-executing IIFE string (anchor-client.gen.ts) that the API serves at
 * /raw/derive-client.js. It used to be a hand-escaped template-literal blob in anchor.ts
 * that re-implemented the content-fingerprint primitives; those now come from the shared
 * `anchor-shared` module (imported here and by the server resolver), so a fingerprint
 * made in the browser equals one made on the server BY CONSTRUCTION.
 *
 * The frame has an opaque origin, so everything rides postMessage:
 *   frame → host:  select / anchors-resolved / anchor-rects / scroll / anchor-click /
 *                  anchor-hover / cursor / cursor-tap / cursor-leave / navigate
 *   host → frame:  anchors / remeasure / focus-anchor / emphasize / scroll-by
 *
 * Keep it dependency-free apart from `anchor-shared` (which is DOM-free + pure) so it
 * bundles into one small self-contained script.
 */

import { findQuoteWithContext, fingerprintFrom, normWs } from "./anchor-shared"

// The element-anchor selector as it arrives from the host (mirrors core's ElementSelector).
interface ElWire {
  type: "ElementSelector"
  tag: string
  role?: string
  id?: string
  css?: string
  fingerprint: string
  ordinal: number
  docFraction: number
  before?: string
  after?: string
  slide?: number
  snapshot?: unknown
}

// One anchor the host asks us to paint — a text quote OR an element selector.
interface Anchor {
  id: string
  exact?: string
  prefix?: string
  suffix?: string
  slide?: number
  el?: ElWire
}

type Band = "high" | "medium" | "low"

// A painted element overlay + the element it tracks + the ancestors that clip it.
interface ElReg {
  id: string
  el: Element
  ov: HTMLDivElement
  clips: Element[]
}
;(() => {
  const post = (m: Record<string, unknown>) => {
    m.source = "derive"
    parent.postMessage(m, "*")
  }
  const scrollTop = () =>
    window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0

  // Jumping to a comment's anchor: a short, FIXED-duration scroll so it feels
  // snappy at any distance — native `behavior: "smooth"` scales its duration
  // with distance and reads as slow/draggy on a long document. Skips the
  // animation for prefers-reduced-motion.
  const fastScrollTo = (top: number, duration = 220) => {
    const from = scrollTop()
    const delta = top - from
    if (Math.abs(delta) < 1) return
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      window.scrollTo(0, top)
      return
    }
    const start = performance.now()
    const easeOutQuad = (t: number) => 1 - (1 - t) * (1 - t)
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      window.scrollTo(0, from + delta * easeOutQuad(t))
      if (t < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  // Narrow an event target to an Element (postMessage/DOM events hand us EventTargets).
  const asEl = (t: EventTarget | null): Element | null => (t instanceof Element ? t : null)

  /* -- selection capture: a text selection becomes a TextQuoteSelector + the
        on-screen rect of the selection, so the host can float a button beside it -- */
  // Build a text quote from a selection Range using the SAME text-node concatenation the
  // resolver greps — so a selection spanning multiple elements captures a quote that
  // actually resolves, with real prefix/suffix context. (The old path took `exact` from
  // Selection.toString(), whose block-boundary newlines don't match the DOM text, and
  // took context from only the anchor node's textContent — so a multi-element comment
  // stored a mismatched quote with empty context and orphaned as "text changed".)
  const quoteFromRange = (
    range: Range,
  ): { exact: string; prefix: string; suffix: string } | null => {
    const nodes = textNodes(document.body)
    let full = ""
    let start = -1
    let end = -1
    const { startContainer: sc, startOffset: so, endContainer: ec, endOffset: eo } = range
    for (const n of nodes) {
      const base = full.length
      const len = n.nodeValue?.length ?? 0
      if (n === sc) start = base + Math.min(so, len)
      if (n === ec) end = base + Math.min(eo, len)
      full += n.nodeValue
    }
    // Element-boundary containers (rare: select-all / triple-click land on an element,
    // not a text node) — map through the range's intersected text nodes instead.
    if (start < 0 || end < 0) {
      let base = 0
      for (const n of nodes) {
        const len = n.nodeValue?.length ?? 0
        if (range.intersectsNode(n)) {
          if (start < 0) start = base
          end = base + len
        }
        base += len
      }
    }
    if (start < 0 || end <= start) return null
    return {
      exact: full.slice(start, end),
      prefix: full.slice(Math.max(0, start - 24), start),
      suffix: full.slice(end, end + 24),
    }
  }

  const emitSelection = () => {
    const s = window.getSelection()
    const t = s ? s.toString().trim() : ""
    // A tap fires a synthesized mouseup with no selection; don't let it clear the
    // block anchor we just placed (tapGuard, set in the touch handler below).
    if (!t || t.length < 2) {
      if (Date.now() - tapGuard < 600) return
      post({ type: "select", selector: null, rect: null })
      return
    }
    let rect: { top: number; bottom: number; left: number; right: number } | null = null
    let quote: { exact: string; prefix: string; suffix: string } | null = null
    try {
      const range = s?.getRangeAt(0)
      if (range) {
        quote = quoteFromRange(range)
        const r = range.getBoundingClientRect()
        if (r && (r.height || r.width))
          rect = { top: r.top, bottom: r.bottom, left: r.left, right: r.right }
      }
    } catch (_e) {}
    post({
      type: "select",
      rect,
      selector: {
        type: "TextQuoteSelector",
        // Fall back to the raw selection text if the range walk didn't yield a quote.
        exact: quote?.exact ?? t,
        prefix: quote?.prefix ?? "",
        suffix: quote?.suffix ?? "",
      },
    })
  }
  document.addEventListener("mouseup", () => setTimeout(emitSelection, 0))

  /* Touch makes "select a phrase, then find a tiny floating button" miserable, and
     iOS pops its own Copy/Look-Up menu over wherever we'd place one. So on touch we
     (a) emit drag-selections on a debounced selectionchange (they glide as you drag
     the handles, no mouseup needed) and (b) treat a clean tap on a text block as a
     coarse "comment on this" anchor. The host shows a bottom bar for both; here we
     just report. tapGuard keeps the collapse that follows a tap from clearing it. */
  let emitT = 0
  let tapGuard = 0
  let tx = 0
  let ty = 0
  let tMoved = false
  const scheduleEmit = () => {
    if (emitT) clearTimeout(emitT)
    emitT = window.setTimeout(emitSelection, 120)
  }
  document.addEventListener("selectionchange", () => {
    const s = window.getSelection()
    if (s && !s.isCollapsed) {
      scheduleEmit()
      return
    }
    if (Date.now() - tapGuard < 600) return
    post({ type: "select", selector: null, rect: null })
  })
  document.addEventListener(
    "touchstart",
    (e) => {
      const t = e.touches?.[0]
      if (t) {
        tx = t.clientX
        ty = t.clientY
        tMoved = false
      }
    },
    { passive: true },
  )
  document.addEventListener(
    "touchmove",
    (e) => {
      const t = e.touches?.[0]
      if (t && (Math.abs(t.clientX - tx) > 10 || Math.abs(t.clientY - ty) > 10)) tMoved = true
    },
    { passive: true },
  )
  document.addEventListener(
    "touchend",
    (e) => {
      const s = window.getSelection()
      if (s && !s.isCollapsed) {
        setTimeout(emitSelection, 0)
        return
      }
      if (tMoved) return
      const el = asEl(e.target)
      if (!el || el.closest("a,button,input,textarea,select,label,[data-derive-id]")) return
      /* touch has no hover, so the desktop chip never appears — a tap on a non-text media
         element (image/chart/video/embed) is how you anchor a comment to it on mobile.
         Text-ish containers (table/pre/figure cells) still fall through to block-tap. */
      const ael = anchorEl(el)
      if (
        ael &&
        /^(img|svg|canvas|video|audio|iframe|embed|object|picture)$/.test(ael.tagName.toLowerCase())
      ) {
        const er = ael.getBoundingClientRect()
        tapGuard = Date.now()
        post({
          type: "select",
          element: true,
          rect: { top: er.top, bottom: er.bottom, left: er.left, right: er.right },
          selector: buildElSelector(ael),
        })
        return
      }
      const b = el.closest("p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,figcaption,dd,dt,pre")
      if (!b) return
      const txt = (b.textContent || "").trim()
      if (txt.length < 2) return
      const r = b.getBoundingClientRect()
      tapGuard = Date.now()
      flashBlock(b as HTMLElement)
      post({
        type: "select",
        block: true,
        rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
        selector: { type: "TextQuoteSelector", exact: txt.slice(0, 180), prefix: "", suffix: "" },
      })
    },
    { passive: true },
  )
  const flashBlock = (b: HTMLElement) => {
    const bg = b.style.backgroundColor
    const tr = b.style.transition
    b.style.transition = "background-color .15s ease"
    b.style.backgroundColor = "rgba(101,89,153,.18)"
    setTimeout(() => {
      b.style.backgroundColor = bg
      setTimeout(() => {
        b.style.transition = tr
      }, 220)
    }, 1000)
  }

  /* -- live cursor: throttled pointer position, DOCUMENT-normalized 0..1 (x by
        width, y by the full document height, including scroll). The host maps it
        back against each viewer's own scroll, so a peer's cursor sits where they
        are IN THE DOCUMENT — not at a fixed screen spot — and glides as you scroll;
        peers scrolled out of view collapse into an edge indicator. Plus an explicit
        leave (pointer left the doc / frame blurred / tab hidden) so peers drop us at
        once, and a tap on click so peers can ripple where we acted. -- */
  let cT = 0
  document.addEventListener("mousemove", (e) => {
    const n = Date.now()
    if (n - cT < 40) return
    cT = n
    const w = window.innerWidth || 1
    const dh = document.documentElement.scrollHeight || 1
    post({ type: "cursor", x: e.clientX / w, y: (e.clientY + scrollTop()) / dh })
  })
  document.addEventListener("mousedown", (e) => {
    const w = window.innerWidth || 1
    const dh = document.documentElement.scrollHeight || 1
    post({ type: "cursor-tap", x: e.clientX / w, y: (e.clientY + scrollTop()) / dh })
  })
  document.addEventListener("mouseleave", () => post({ type: "cursor-leave" }))
  window.addEventListener("blur", () => post({ type: "cursor-leave" }))
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) post({ type: "cursor-leave" })
  })

  /* -- highlight styles (mark's default yellow is overridden) -- */
  const st = document.createElement("style")
  st.textContent =
    /* Text-comment highlights paint through the CSS Custom Highlight API (::highlight),
       NOT <mark> DOM wraps — so we never mutate the artifact's own DOM, and OVERLAPPING
       comments render correctly (the old mark-wrapping nested awkwardly). `::highlight`
       only supports color / background / text-decoration / text-shadow (no border or
       radius), so the underline is a text-decoration. The `overlap` layer paints the
       intersection of two+ comments a step darker so a stacked region reads as such;
       `on` (hovered/active) and `flash` (jump target) sit above it by priority. */
    "::highlight(derive-hl){background-color:rgba(100,116,139,.20);text-decoration-line:underline;text-decoration-color:rgba(100,116,139,.55);text-decoration-thickness:2px}" +
    "::highlight(derive-hl-overlap){background-color:rgba(100,116,139,.30);text-decoration-line:underline;text-decoration-color:rgba(100,116,139,.85);text-decoration-thickness:2px}" +
    "::highlight(derive-hl-on){background-color:rgba(100,116,139,.42);text-decoration-color:rgba(100,116,139,.95)}" +
    "::highlight(derive-hl-flash){background-color:rgba(100,116,139,.72)}" +
    /* element overlays: a non-text anchor draws an outline box (pointer-events off so
       the element stays interactive) with a clickable comment badge in its corner. A
       low-confidence relocation reads dashed to signal "we think it moved here". */
    ".derive-el-hl{position:absolute;pointer-events:none;border:2px solid rgba(100,116,139,.55);border-radius:4px;box-shadow:0 0 0 3px rgba(100,116,139,.12);transition:border-color .15s,box-shadow .15s,opacity .15s;z-index:2147483640}" +
    /* low confidence (a relocation we're unsure about) = a quiet hint, never an alarm.
       At rest there's NO box at all — just the small badge with a tiny 'moved' pip. The
       faint dashed outline appears only when you hover the badge, so the document stays
       calm and the signal is opt-in. */
    ".derive-el-hl.derive-el-low{border-color:transparent;box-shadow:none}" +
    ".derive-el-hl.derive-el-low:hover,.derive-el-hl.derive-el-low.derive-el-on{border:1px dashed rgba(100,116,139,.5)}" +
    ".derive-el-hl.derive-el-on{border-color:rgba(100,116,139,.95);box-shadow:0 0 0 4px rgba(100,116,139,.22)}" +
    ".derive-el-hl.derive-el-flash{animation:derive-el-flash 1s ease 2}" +
    "@keyframes derive-el-flash{50%{box-shadow:0 0 0 6px rgba(100,116,139,.4)}}" +
    ".derive-el-badge{position:absolute;top:-11px;right:-11px;width:22px;height:22px;border-radius:11px;background:rgba(100,116,139,.95);color:#fff;font:600 12px/22px system-ui,sans-serif;text-align:center;pointer-events:auto;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.25)}" +
    /* on a moved (low-confidence) badge: dimmed, with a tiny pip marking 'approximate'.
       Brightens on hover so it's findable without being loud. */
    ".derive-el-low .derive-el-badge{background:rgba(100,116,139,.55);box-shadow:0 1px 3px rgba(0,0,0,.16)}" +
    ".derive-el-low:hover .derive-el-badge{background:rgba(100,116,139,.95)}" +
    ".derive-el-pip{position:absolute;bottom:-2px;right:-2px;width:8px;height:8px;border-radius:50%;background:rgba(100,116,139,.85);border:1.5px solid #fff;box-sizing:content-box}" +
    /* the hover affordance: a small 'Comment' chip that follows the pointer over an
       anchorable element; clicking it pins a comment to that element. */
    ".derive-el-chip{position:absolute;display:none;align-items:center;gap:6px;padding:5px 10px;border-radius:8px;background:#fff;color:#14161a;border:1px solid rgba(20,22,26,.1);font:500 12px/1 system-ui,-apple-system,sans-serif;pointer-events:auto;cursor:pointer;box-shadow:0 6px 20px -6px rgba(0,0,0,.28),0 1px 2px rgba(0,0,0,.1);z-index:2147483641;white-space:nowrap}" +
    ".derive-el-outline{position:absolute;display:none;pointer-events:none;border:2px dashed rgba(100,116,139,.6);border-radius:4px;z-index:2147483639}"
  ;(document.head || document.documentElement).appendChild(st)

  /* === Element anchors ========================================================
     Pin a comment to a non-text element (image, chart, table, embed, code, figure).
     We capture several independent signals and resolve by agreement — a cascade:
     id -> css -> content fingerprint -> structural ordinal -> geometry -> neighbors.
     The fingerprint primitives come from the shared `anchor-shared` module, so a
     fingerprint made here equals one made on the server. */
  const elSrc = (el: Element): string => el.getAttribute("src") || el.getAttribute("href") || ""
  const elAlt = (el: Element): string =>
    el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("title") || ""
  const elText = (el: Element): string => normWs(el.textContent || "")
  const elFp = (el: Element): string =>
    fingerprintFrom(el.tagName.toLowerCase(), elSrc(el), elAlt(el), elText(el))
  const elOrdinal = (el: Element): number => {
    const list = document.getElementsByTagName(el.tagName)
    for (let i = 0; i < list.length; i++) if (list[i] === el) return i
    return 0
  }
  /* nearest preceding/following text block, in document order. Walks OUTWARD from el
     (prev/next siblings, then up a level) instead of scanning every block in the doc —
     the old querySelectorAll+compareDocumentPosition was O(blocks) PER candidate, so a
     large gallery froze the frame for seconds (1500 imgs ~1.7s). The nearest block is
     almost always a sibling or one level up, so this is effectively O(1). */
  const BLOCKS = "p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,figcaption,dd,dt,pre"
  const isBlock = (n: Element): boolean => n.nodeType === 1 && !!n.matches && n.matches(BLOCKS)
  /* deepest block at the trailing (last=true) or leading edge of root's subtree, incl root */
  const edgeBlockText = (root: Element, last: boolean): string | null => {
    if (root.nodeType !== 1) return null
    const bl = root.querySelectorAll
      ? root.querySelectorAll(BLOCKS)
      : ([] as unknown as NodeListOf<Element>)
    for (let i = 0; i < bl.length; i++) {
      const b = bl[last ? bl.length - 1 - i : i]
      const t = normWs(b?.textContent || "")
      if (t.length >= 2) return t
    }
    if (isBlock(root)) {
      const rt = normWs(root.textContent || "")
      if (rt.length >= 2) return rt
    }
    return null
  }
  const neighborText = (el: Element): { before: string | null; after: string | null } => {
    let before: string | null = null
    let after: string | null = null
    let hops = 0
    for (let n: Element | null = el; n?.parentElement && !before && hops < 400; n = n.parentElement)
      for (
        let s = n.previousElementSibling;
        s && !before && hops < 400;
        s = s.previousElementSibling
      ) {
        hops++
        before = edgeBlockText(s, true)
      }
    hops = 0
    for (let m: Element | null = el; m?.parentElement && !after && hops < 400; m = m.parentElement)
      for (let p = m.nextElementSibling; p && !after && hops < 400; p = p.nextElementSibling) {
        hops++
        after = edgeBlockText(p, false)
      }
    return { before, after }
  }
  /* structural css path of tag:nth-of-type up to a stable ancestor (authored id or body) */
  const cssPath = (el: Element): string => {
    const parts: string[] = []
    let n: Element | null = el
    for (let depth = 0; n && n.nodeType === 1 && depth < 8; depth++) {
      const tag = n.tagName.toLowerCase()
      if (looksAuthoredId(n.id)) {
        parts.unshift(`#${n.id}`)
        break
      }
      if (tag === "body") {
        parts.unshift("body")
        break
      }
      let k = 1
      for (let c = n.previousElementSibling; c; c = c.previousElementSibling)
        if (c.tagName === n.tagName) k++
      parts.unshift(`${tag}:nth-of-type(${k})`)
      n = n.parentElement
    }
    return parts.join(">")
  }
  const looksAuthoredId = (id: string): boolean =>
    !!id && !/[0-9a-f]{8}|^[0-9]|^(radix|headlessui|react|mui|:r)/i.test(id)
  const ANCHORABLE = "img,picture,svg,canvas,video,audio,iframe,embed,object,table,pre,figure"
  const anchorEl = (t: Element | null): Element | null => {
    if (!t?.closest) return null
    if (
      t.closest(
        "[data-derive-id],.derive-el-chip,.derive-el-badge,a,button,input,textarea,select,label",
      )
    )
      return null
    const el = t.closest(ANCHORABLE)
    if (el) return el
    const div = t.closest("div,section,figure")
    if (div && /chart|graph|plot|viz|sparkline/i.test(`${div.className || ""} ${div.id || ""}`))
      return div
    return null
  }
  const roleOf = (el: Element): string => {
    const tag = el.tagName.toLowerCase()
    if (tag === "img" || tag === "picture") return "image"
    if (tag === "video" || tag === "audio") return "media"
    if (tag === "iframe" || tag === "embed" || tag === "object") return "embed"
    if (tag === "table") return "table"
    if (tag === "pre" || tag === "code") return "code"
    if (tag === "svg" || tag === "canvas") return "chart"
    if (tag === "figure") return "figure"
    if (/chart|graph|plot|viz|sparkline/i.test(`${el.className || ""} ${el.id || ""}`))
      return "chart"
    return "block"
  }
  const hostOf = (u: string): string => {
    const m = (u || "").match(/^https?:\/\/([^/]+)/i)
    return m?.[1] ? m[1].replace(/^www\./, "") : ""
  }
  const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
  const labelOf = (el: Element, role: string): string => {
    const alt = normWs(elAlt(el))
    const host = hostOf(elSrc(el))
    if (role === "image")
      return alt ? `Image — ${trunc(alt, 48)}` : host ? `Image — ${host}` : "Image"
    if (role === "chart") return alt ? `Chart — ${trunc(alt, 48)}` : "Chart"
    if (role === "media")
      return el.tagName.toLowerCase() === "audio" ? "Audio" : host ? `Video — ${host}` : "Video"
    if (role === "embed") return host ? `Embedded — ${host}` : "Embedded content"
    if (role === "table") return "Table"
    if (role === "code") return "Code block"
    if (role === "figure") return alt ? `Figure — ${trunc(alt, 48)}` : "Figure"
    return trunc(elText(el) || el.tagName.toLowerCase(), 48) || "Element"
  }
  const buildElSelector = (el: Element): Record<string, unknown> => {
    const tag = el.tagName.toLowerCase()
    const role = roleOf(el)
    const nb = neighborText(el)
    const r = el.getBoundingClientRect()
    const dh = document.documentElement.scrollHeight || 1
    const id = looksAuthoredId(el.id) ? el.id : undefined
    let html = el.outerHTML || ""
    if (html.length > 2000) html = html.slice(0, 2000)
    return {
      type: "ElementSelector",
      tag,
      role,
      id,
      css: cssPath(el),
      fingerprint: elFp(el),
      ordinal: elOrdinal(el),
      docFraction: (r.top + scrollTop()) / dh,
      before: nb.before || undefined,
      after: nb.after || undefined,
      snapshot: {
        tag,
        label: labelOf(el, role),
        text: trunc(elText(el), 300) || undefined,
        src: elSrc(el) || undefined,
        alt: normWs(elAlt(el)) || undefined,
        w: Math.round(r.width) || undefined,
        h: Math.round(r.height) || undefined,
        html,
      },
    }
  }

  /* -- the in-browser cascade: score every candidate by signal agreement and pick
        the best over threshold (mirrors resolveElement in core) -- */
  const textClose = (a: string, b: string): boolean => {
    if (typeof a !== "string" || typeof b !== "string") return false
    const x = a.toLowerCase()
    const y = b.toLowerCase()
    if (x === y) return true
    const sh = x.length < y.length ? x : y
    const lo = x.length < y.length ? y : x
    if (sh.length >= 8 && lo.indexOf(sh) >= 0) return true
    const w = Math.min(16, sh.length)
    return w >= 8 && lo.slice(0, w) === sh.slice(0, w)
  }
  const scoreEl = (el: Element, a: ElWire, fpM: number): { c: number; signals: string[] } => {
    let score = 0
    let max = 0
    const signals: string[] = []
    if (a.id) {
      max += 5
      if (el.id === a.id) {
        score += 5
        signals.push("id")
      }
    }
    max += 5
    if (elFp(el) === a.fingerprint) {
      score += 5
      signals.push("content")
    }
    if (a.css) {
      max += 3
      if (cssPath(el) === a.css) {
        score += 3
        signals.push("css")
      }
    }
    /* drop ordinal when content repeats across candidates (same logo per slide) — it's
       the signal an insertion scrambles; let neighbors/geometry pick the instance */
    if (fpM <= 1) {
      max += 3
      if (el.tagName.toLowerCase() === a.tag) {
        if (elOrdinal(el) === a.ordinal) {
          score += 3
          signals.push("position")
        } else score += 1
      }
    }
    if (a.before || a.after) {
      const nb = neighborText(el)
      if (a.before) {
        max += 1
        if (textClose(a.before, nb.before || "")) {
          score += 1
          signals.push("nb")
        }
      }
      if (a.after) {
        max += 1
        if (textClose(a.after, nb.after || "")) {
          score += 1
          signals.push("nb")
        }
      }
    }
    max += 1
    const r = el.getBoundingClientRect()
    const dh = document.documentElement.scrollHeight || 1
    const f = (r.top + scrollTop()) / dh
    score += 1 * (1 - Math.min(1, Math.abs(f - (a.docFraction || 0))))
    return { c: max > 0 ? score / max : 0, signals }
  }
  const resolveEl = (
    a: ElWire,
  ): { el: Element; confidence: number; band: Band; signals: string[] } | null => {
    const cand: Element[] = []
    const seen: Element[] = []
    if (a.tag) {
      const bt = document.getElementsByTagName(a.tag)
      for (let i = 0; i < bt.length; i++) {
        const el = bt[i]
        if (el) {
          cand.push(el)
          seen.push(el)
        }
      }
    }
    if (a.id) {
      const byId = document.getElementById(a.id)
      if (byId && seen.indexOf(byId) < 0) cand.push(byId)
    }
    /* count how many candidates share the recorded fingerprint / id — a strong
       signal matching MANY candidates isn't identifying (a gallery of identical
       thumbnails), so it can't grant high confidence (mirrors core's grade()). */
    let fpM = 0
    let idM = 0
    for (const c of cand) {
      if (elFp(c) === a.fingerprint) fpM++
      if (a.id && c.id === a.id) idM++
    }
    let best: { c: number; signals: string[] } | null = null
    let bestEl: Element | null = null
    let runnerUp = 0
    for (const c of cand) {
      const s = scoreEl(c, a, fpM)
      if (!best || s.c > best.c) {
        if (best && best.c > runnerUp) runnerUp = best.c
        best = s
        bestEl = c
      } else if (s.c > runnerUp) runnerUp = s.c
    }
    if (!best || best.c < 0.42 || !bestEl) return null
    const g = gradeEl(best.signals, best.c, fpM, idM, best.c - runnerUp)
    return { el: bestEl, confidence: g.c, band: g.band, signals: best.signals }
  }
  const gradeEl = (
    sig: string[],
    conf: number,
    fpM: number,
    idM: number,
    margin: number,
  ): { band: Band; c: number } => {
    const mId = sig.indexOf("id") >= 0
    const mContent = sig.indexOf("content") >= 0
    const nb = sig.indexOf("nb") >= 0
    const uniq = (mId && idM === 1) || (mContent && fpM === 1)
    const ambig = (mId && idM > 1) || (mContent && fpM > 1)
    /* id and content point at different elements (swapped content) -> never high */
    const conflict = (mId && !mContent && fpM > 0) || (mContent && !mId && idM > 0)
    if (ambig && !uniq && !nb) return { band: "low", c: Math.min(conf, 0.45) }
    if (conflict) return { band: "medium", c: Math.min(conf, 0.6) }
    if (uniq && conf >= 0.6 && margin >= 0.12) return { band: "high", c: conf }
    if ((uniq || nb || sig.indexOf("position") >= 0) && conf >= 0.5)
      return { band: "medium", c: Math.min(conf, 0.75) }
    return { band: "low", c: Math.min(conf, 0.5) }
  }

  /* overlay registry: each resolved element anchor gets an absolutely-positioned
     outline (in document coords, so it glides with scroll) + a corner badge. */
  let elReg: ElReg[] = []
  const clearEls = () => {
    for (const o of elReg) if (o.ov?.parentNode) o.ov.parentNode.removeChild(o.ov)
    elReg = []
  }
  const paintEl = (id: string, el: Element, band: Band) => {
    const low = band === "low"
    const ov = document.createElement("div")
    ov.className = `derive-el-hl${low ? " derive-el-low" : ""}`
    ov.setAttribute("data-derive-id", id)
    const badge = document.createElement("div")
    badge.className = "derive-el-badge"
    badge.setAttribute("data-derive-id", id)
    badge.textContent = "💬"
    /* a moved (low-confidence) anchor gets a tiny pip + an explanatory title; nothing
       louder. medium/high look like a normal anchored comment. */
    if (low) {
      badge.title = "View comment · moved here (approximate)"
      const pip = document.createElement("div")
      pip.className = "derive-el-pip"
      badge.appendChild(pip)
    } else badge.title = "View comment"
    /* multiple comments on the SAME element would stack their badges at the identical
       corner — only the top one is then clickable. Fan each extra badge left so every
       comment's badge stays reachable in the document. */
    let stack = 0
    for (const s of elReg) if (s.el === el) stack++
    if (stack > 0)
      badge.style.right = `${-11 + stack * 24}px` /* fan left, staying over the element */
    ov.appendChild(badge)
    document.body.appendChild(ov)
    elReg.push({ id, el, ov, clips: clipAncestors(el) })
  }
  /* ancestors that clip their overflow (a scrollable panel, a code block) — captured
     once at paint so the hot positioning path is rect math, not getComputedStyle. The
     overlay lives at the body level and isn't clipped by them, so when the element
     scrolls out of one, WE must hide the overlay or it floats over unrelated content. */
  const clipAncestors = (el: Element): Element[] => {
    const out: Element[] = []
    for (
      let p = el.parentElement;
      p && p !== document.body && p !== document.documentElement;
      p = p.parentElement
    ) {
      try {
        const st2 = getComputedStyle(p)
        const ov = (st2.overflow || "") + (st2.overflowX || "") + (st2.overflowY || "")
        if (/auto|scroll|hidden|clip/.test(ov)) out.push(p)
      } catch (_c) {}
    }
    return out
  }
  const clippedOut = (r: DOMRect, clips: Element[]): boolean => {
    if (!clips) return false
    for (const cl of clips) {
      const c = cl.getBoundingClientRect()
      if (r.bottom <= c.top || r.top >= c.bottom || r.right <= c.left || r.left >= c.right)
        return true
    }
    return false
  }
  let reTick = 0
  const positionEls = () => {
    const sy = scrollTop()
    const sx = window.scrollX || 0
    let detached = false
    for (const e of elReg) {
      /* the artifact's JS may REMOVE+recreate an element (a tab switch, an SPA re-render).
         A detached element isn't just moved — repositioning can't help; we must RESOLVE
         again to re-attach to the replacement. (A merely hidden element stays attached →
         handled by the size check below, no re-resolve.) */
      if (!document.contains(e.el)) {
        detached = true
        e.ov.style.display = "none"
        continue
      }
      const r = e.el.getBoundingClientRect()
      if (!(r.width || r.height) || clippedOut(r, e.clips)) {
        e.ov.style.display = "none"
        continue
      }
      e.ov.style.display = "block"
      e.ov.style.left = `${r.left + sx}px`
      e.ov.style.top = `${r.top + sy}px`
      e.ov.style.width = `${r.width}px`
      e.ov.style.height = `${r.height}px`
    }
    if (detached && lastAnchors && !reTick)
      reTick = window.setTimeout(() => {
        reTick = 0
        if (lastAnchors) applyAnchors(lastAnchors)
      }, 150)
  }

  /* hover affordance: a 'Comment' chip parked at the top-right of the anchorable
     element under the pointer; clicking it pins a comment to that element. */
  let chip: HTMLDivElement | null = null
  let chipEl: Element | null = null
  const ensureChip = (): HTMLDivElement => {
    if (chip) return chip
    chip = document.createElement("div")
    chip.className = "derive-el-chip"
    chip.textContent = "💬 Comment"
    chip.addEventListener("click", (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      if (!chipEl) return
      const el = chipEl
      const r = el.getBoundingClientRect()
      // Guard the element selection we're about to place, exactly as the touch element-
      // tap does: this click was preceded by a mouseup, which scheduled emitSelection —
      // and with no text selected that would post a null `select` a beat later, wiping
      // this one out (the reason clicking the chip appeared to do nothing). tapGuard
      // makes emitSelection / selectionchange skip their null-post for a short window.
      tapGuard = Date.now()
      /* the host stamps the deck slide onto the selector, same as the text path. */
      post({
        type: "select",
        element: true,
        rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
        selector: buildElSelector(el),
      })
    })
    document.body.appendChild(chip)
    return chip
  }
  const showChip = (el: Element) => {
    const c = ensureChip()
    const r = el.getBoundingClientRect()
    chipEl = el
    c.style.display = "inline-flex"
    c.style.left = `${r.right + window.scrollX - Math.min(110, r.width)}px`
    c.style.top = `${r.top + scrollTop() - 10}px`
  }
  const hideChip = () => {
    if (chip) chip.style.display = "none"
    chipEl = null
  }
  document.addEventListener("mouseover", (e) => {
    const el = anchorEl(asEl(e.target))
    if (el) showChip(el)
  })
  document.addEventListener("mouseout", (e) => {
    /* keep the chip while the pointer is on the chip itself or still over the element */
    const to = asEl(e.relatedTarget)
    if (to && (to.closest(".derive-el-chip") || anchorEl(to) === chipEl)) return
    if (!anchorEl(asEl(e.target))) return
    hideChip()
  })

  const textNodes = (root: Node): Text[] => {
    const w = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const p = n.parentNode ? n.parentNode.nodeName : ""
        return p === "SCRIPT" || p === "STYLE" || p === "NOSCRIPT"
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT
      },
    })
    const out: Text[] = []
    let n: Node | null
    // biome-ignore lint/suspicious/noAssignInExpressions: standard TreeWalker iteration
    while ((n = w.nextNode())) out.push(n as Text)
    return out
  }
  /* === Text-comment highlights via the CSS Custom Highlight API ==============
     Each text comment's live Range is kept in `textEntries` (for hit-testing +
     rect reporting), and — where the API exists — painted as a CSS Highlight. No
     <mark> DOM wrapping, so we never touch the artifact's own DOM and overlaps
     paint correctly. Where the API is missing the comments still work (cards pin +
     jump via range rects); only the in-document tint + click-on-text are skipped. */
  interface TextEntry {
    id: string
    range: Range
  }
  let textEntries: TextEntry[] = []
  // biome-ignore lint/suspicious/noExplicitAny: the Highlight registry types vary by lib version; feature-detected + guarded.
  const hlReg: any =
    typeof CSS !== "undefined" && (CSS as unknown as { highlights?: unknown }).highlights
  const HL_SUPPORTED =
    !!hlReg && typeof (globalThis as { Highlight?: unknown }).Highlight === "function"
  // biome-ignore lint/suspicious/noExplicitAny: Highlight is feature-detected above.
  const HighlightCtor = (globalThis as any).Highlight
  const baseHl = HL_SUPPORTED ? new HighlightCtor() : null
  const overlapHl = HL_SUPPORTED ? new HighlightCtor() : null
  const onHl = HL_SUPPORTED ? new HighlightCtor() : null
  const flashHl = HL_SUPPORTED ? new HighlightCtor() : null
  if (HL_SUPPORTED) {
    // Priority orders the painters where ranges overlap: base < overlap < on < flash.
    hlReg.set("derive-hl", baseHl)
    hlReg.set("derive-hl-overlap", overlapHl)
    hlReg.set("derive-hl-on", onHl)
    hlReg.set("derive-hl-flash", flashHl)
    if (overlapHl) overlapHl.priority = 1
    if (onHl) onHl.priority = 2
    if (flashHl) flashHl.priority = 3
  }

  /* A DOM Range spanning [s,e) of root's concatenated text — the counterpart to the
     old wrapIn, but it MUTATES NOTHING: it just locates the boundary text nodes. */
  const rangeAt = (root: Node, s: number, e: number): Range | null => {
    const nodes = textNodes(root)
    const range = document.createRange()
    let acc = 0
    let started = false
    let lastNode: Text | null = null
    for (const node of nodes) {
      const len = node.nodeValue?.length ?? 0
      if (!started && s <= acc + len) {
        range.setStart(node, Math.max(0, Math.min(len, s - acc)))
        started = true
      }
      if (started && e <= acc + len) {
        range.setEnd(node, Math.max(0, Math.min(len, e - acc)))
        return range
      }
      acc += len
      lastNode = node
    }
    // `e` ran past the available text — clamp the end to the last node so a slightly
    // over-long stored quote still paints (never returns a half-open range).
    if (started && lastNode) {
      range.setEnd(lastNode, lastNode.nodeValue?.length ?? 0)
      return range
    }
    return null
  }
  const clearText = () => {
    textEntries = []
    baseHl?.clear()
    overlapHl?.clear()
    onHl?.clear()
    flashHl?.clear()
  }
  const addText = (id: string, range: Range) => {
    textEntries.push({ id, range })
  }
  // Intersection of two ranges (the later start, the earlier end), or null if disjoint.
  const intersect = (a: Range, b: Range): Range | null => {
    try {
      const r = document.createRange()
      if (a.compareBoundaryPoints(Range.START_TO_START, b) >= 0)
        r.setStart(a.startContainer, a.startOffset)
      else r.setStart(b.startContainer, b.startOffset)
      if (a.compareBoundaryPoints(Range.END_TO_END, b) <= 0) r.setEnd(a.endContainer, a.endOffset)
      else r.setEnd(b.endContainer, b.endOffset)
      return r.collapsed ? null : r
    } catch (_e) {
      return null
    }
  }
  // Repaint the base highlight from every entry, plus an overlap layer for the regions
  // two+ comments share, so a stacked span reads a step darker.
  const paintText = () => {
    if (!HL_SUPPORTED || !baseHl) return
    baseHl.clear()
    overlapHl?.clear()
    for (const t of textEntries) baseHl.add(t.range)
    if (overlapHl)
      for (let i = 0; i < textEntries.length; i++)
        for (let j = i + 1; j < textEntries.length; j++) {
          const a = textEntries[i]
          const b = textEntries[j]
          if (!a || !b) continue
          const inter = intersect(a.range, b.range)
          if (inter) overlapHl.add(inter)
        }
  }
  /* The caret node+offset under a viewport point, across the two browser APIs, for
     hit-testing a click/hover against the comment ranges (there are no <mark> elements
     to catch the event anymore). */
  const caretAt = (x: number, y: number): { node: Node; offset: number } | null => {
    const d = document as unknown as {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
      caretRangeFromPoint?: (x: number, y: number) => Range | null
    }
    if (d.caretPositionFromPoint) {
      const p = d.caretPositionFromPoint(x, y)
      return p ? { node: p.offsetNode, offset: p.offset } : null
    }
    if (d.caretRangeFromPoint) {
      const r = d.caretRangeFromPoint(x, y)
      return r ? { node: r.startContainer, offset: r.startOffset } : null
    }
    return null
  }
  // Which comment covers a viewport point — the SMALLEST covering range wins, so a
  // click on a stacked region focuses the most specific comment (the others stay
  // reachable as pinned cards in the margin).
  const textHitAt = (x: number, y: number): string | null => {
    if (!textEntries.length) return null
    const c = caretAt(x, y)
    if (!c) return null
    let best: { id: string; len: number } | null = null
    for (const { id, range } of textEntries) {
      try {
        if (range.comparePoint(c.node, c.offset) === 0) {
          const len = range.toString().length
          if (!best || len < best.len) best = { id, len }
        }
      } catch (_e) {}
    }
    return best?.id ?? null
  }
  /* root's concatenated-text span for a text anchor — context match first (to
     disambiguate a repeated quote), then the exact, both WHITESPACE-FLEXIBLE via the
     SHARED findQuoteWithContext, so a quote spanning block elements (whose inter-block
     whitespace differs between the Selection, the DOM text, and the source) still
     resolves, and identically to the server's reanchor. Returns the exact's span. */
  const findIn = (root: Node, a: Anchor): { start: number; end: number } | null => {
    const nodes = textNodes(root)
    let full = ""
    for (const node of nodes) full += node.nodeValue
    return findQuoteWithContext(full, a.exact || "", a.prefix, a.suffix)
  }
  // The element ancestor of a range's start (its start is a text node) — for slide lookup.
  const rangeStartEl = (r: Range): Element | null => {
    const n = r.startContainer
    return n.nodeType === 1 ? (n as Element) : n.parentElement
  }
  /* deck slides, ordered: explicit [data-derive-slide] (sorted) else .slide in document
     order. Empty on a non-deck artifact — then anchors resolve against the whole doc. */
  const slideEls = (): Element[] => {
    const ex = document.querySelectorAll("[data-derive-slide]")
    if (ex.length)
      return Array.from(ex).sort(
        (a, b) =>
          Number(a.getAttribute("data-derive-slide")) - Number(b.getAttribute("data-derive-slide")),
      )
    return Array.from(document.querySelectorAll(".slide"))
  }
  /* nearest slide ancestor of a DOM element (element anchors + a text range's start) */
  const slideOfEl = (el: Element | null, slides: Element[]): number | null => {
    for (let s = el; s; s = s.parentElement) {
      const k = slides.indexOf(s)
      if (k >= 0) return k
    }
    return null
  }

  /* doc-absolute top of each anchor — text marks AND element overlays — so the host
     pins each card beside whatever it points at. We DEDUPE the host post: a dynamic
     artifact (a live ticker, a 60fps animation) fires the MutationObserver every frame,
     but if nothing the host cares about actually moved (same tops/scroll/size), posting
     would re-render the comment layout 60fps for nothing. Overlays are still repositioned
     in-frame each call; only the cross-frame message is gated on a real change. */
  let lastRects = ""
  const reportRects = () => {
    const tops: Record<string, number> = {}
    const seen: Record<string, number> = {}
    const sy = scrollTop()
    for (const { id, range } of textEntries) {
      if (seen[id]) continue
      seen[id] = 1
      tops[id] = range.getBoundingClientRect().top + sy
    }
    positionEls()
    for (const e of elReg) {
      if (seen[e.id]) continue
      if (e.ov.style.display === "none") continue
      seen[e.id] = 1
      tops[e.id] = e.el.getBoundingClientRect().top + sy
    }
    const payload = {
      type: "anchor-rects",
      tops,
      scrollY: sy,
      viewH: window.innerHeight,
      docH: document.documentElement.scrollHeight,
    }
    const sig = JSON.stringify(payload)
    if (sig === lastRects) return /* nothing the host pins to changed — skip the re-render */
    lastRects = sig
    post(payload)
  }
  const reportScroll = () =>
    post({
      type: "scroll",
      scrollY: scrollTop(),
      viewH: window.innerHeight,
      docH: document.documentElement.scrollHeight,
    })

  /* Resolve each anchor, scoping a deck comment to its recorded slide FIRST (so the
     same phrase on two slides can't collide), then falling back to a whole-document
     search if the text has moved off that slide. Reports, per id, whether it resolved
     and which slide it actually landed in (null = outside any slide / non-deck). */
  let lastAnchors: Anchor[] | null = null
  const applyAnchors = (anchors: Anchor[]) => {
    lastAnchors = anchors /* kept so we can re-resolve if an element is replaced */
    clearText()
    clearEls()
    const slides = slideEls()
    const resolved: Record<string, boolean> = {}
    const landed: Record<string, number | null> = {}
    const conf: Record<string, { confidence: number; band: Band; signals: string[] }> = {}
    for (const a of anchors) {
      /* element anchor: a.el is the stored ElementSelector. Resolve via the cascade,
         paint an outline overlay, and report confidence so the host can flag a
         low-confidence relocation as "moved". */
      if (a.el) {
        const m = resolveEl(a.el)
        if (m) {
          paintEl(a.id, m.el, m.band)
          resolved[a.id] = true
          landed[a.id] = slides.length ? slideOfEl(m.el, slides) : null
          conf[a.id] = { confidence: m.confidence, band: m.band, signals: m.signals }
        } else {
          resolved[a.id] = false
          landed[a.id] = a.el.slide != null ? a.el.slide : null
        }
        continue
      }
      /* text anchor: scope a deck comment to its recorded slide FIRST (so the same
         phrase on two slides can't collide), then fall back to a whole-document
         search if the text moved off that slide. Builds a Range (no DOM mutation) from
         the resolved span; the highlight is painted from every range together, below. */
      const slide = a.slide != null ? slides[a.slide] : undefined
      let range: Range | null = null
      let where: number | null = null
      if (a.slide != null && slide) {
        const span = findIn(slide, a)
        if (span) {
          range = rangeAt(slide, span.start, span.end)
          where = a.slide
        }
      }
      if (!range) {
        const span = findIn(document.body, a)
        if (span) {
          range = rangeAt(document.body, span.start, span.end)
          where = slides.length && range ? slideOfEl(rangeStartEl(range), slides) : null
        }
      }
      if (range) addText(a.id, range)
      resolved[a.id] = !!range
      landed[a.id] = range ? where : null
    }
    paintText()
    post({ type: "anchors-resolved", resolved, slides: landed, conf })
    reportRects()
  }

  /* live scroll + resize, rAF-throttled so cards glide with the text */
  let sTick = 0
  window.addEventListener(
    "scroll",
    () => {
      if (sTick) return
      sTick = requestAnimationFrame(() => {
        sTick = 0
        if (elReg.length) positionEls()
        reportScroll()
      })
    },
    true,
  )
  let rTick = 0
  const reflow = () => {
    if (rTick) return
    rTick = requestAnimationFrame(() => {
      rTick = 0
      positionEls()
      // A text Range whose start node was detached (the artifact re-rendered that
      // subtree) can't be repositioned — re-resolve from the stored anchors, debounced,
      // the same way positionEls re-resolves a detached element overlay.
      const stale = textEntries.some((t) => !t.range.startContainer.isConnected)
      if (stale && lastAnchors && !reTick)
        reTick = window.setTimeout(() => {
          reTick = 0
          if (lastAnchors) applyAnchors(lastAnchors)
        }, 150)
      reportRects()
    })
  }
  window.addEventListener("resize", reflow)
  /* images/fonts settle after load — re-measure a few times so pins land right */
  window.addEventListener("load", () => {
    reportRects()
    setTimeout(reportRects, 400)
    setTimeout(reportRects, 1200)
  })
  /* The artifact's OWN scripts can mutate the DOM after load (a chart library renders,
     content animates, an accordion expands) — none of which fire scroll/resize/load. So
     overlays would strand over stale positions. Watch for document size changes
     (ResizeObserver) and DOM edits (MutationObserver) and re-pin. reflow is rAF-gated, so
     a burst of mutations coalesces to one reposition per frame, and the cost is O(anchors)
     not O(DOM). */
  try {
    if (window.ResizeObserver) new ResizeObserver(reflow).observe(document.documentElement)
  } catch (_r) {}
  try {
    if (window.MutationObserver)
      new MutationObserver(reflow).observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
      })
  } catch (_m) {}

  /* hover a highlight -> emphasize its card in the host. Text highlights are painted
     ranges (no element to catch mouseover), so we hit-test the pointer against the
     comment ranges on a throttled mousemove; an element badge is a real node, caught by
     closest(). One posted id (or null) whichever it is; deduped so we don't spam. */
  let hoverId: string | null = null
  let hoverTick = 0
  const setHover = (id: string | null) => {
    if (id === hoverId) return
    hoverId = id
    post({ type: "anchor-hover", id })
  }
  document.addEventListener("mousemove", (e) => {
    if (hoverTick) return
    const x = e.clientX
    const y = e.clientY
    const target = e.target
    hoverTick = window.setTimeout(() => {
      hoverTick = 0
      const badge = asEl(target)?.closest(".derive-el-badge[data-derive-id]")
      setHover(badge ? badge.getAttribute("data-derive-id") : HL_SUPPORTED ? textHitAt(x, y) : null)
    }, 60)
  })
  // The pointer left the document — clear any emphasis (no more mousemoves will fire to
  // hit-test it off). Without this a card stays lit after the mouse exits the iframe.
  document.addEventListener("mouseleave", () => setHover(null))
  /* clicking a highlight (text range or element badge) focuses its thread in the host */
  document.addEventListener(
    "click",
    (e) => {
      const badge = asEl(e.target)?.closest(".derive-el-badge[data-derive-id]")
      if (badge) {
        post({ type: "anchor-click", id: badge.getAttribute("data-derive-id") })
        return
      }
      const hit = HL_SUPPORTED ? textHitAt(e.clientX, e.clientY) : null
      if (hit) {
        post({ type: "anchor-click", id: hit })
        return
      }
      navLink(e)
    },
    true,
  )
  /* Cross-document links: a relative <a> the server resolved to a sibling artifact
     (data-derive-nav="<ref>"). The sandboxed frame can't navigate the host, so hand the
     click off for an in-app transition (or a new tab on a modified / middle click —
     the host opens that un-sandboxed). preventDefault stops the frame loading /artifacts/… into
     itself. Only marked links are touched; ordinary and in-page links are untouched. */
  const navLink = (e: MouseEvent) => {
    const a = asEl(e.target)?.closest("a[data-derive-nav]")
    if (!a) return
    e.preventDefault()
    post({
      type: "navigate",
      ref: a.getAttribute("data-derive-nav"),
      newTab: !!(e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1),
    })
  }
  document.addEventListener(
    "auxclick",
    (e) => {
      if (e.button === 1) navLink(e)
    },
    true,
  )

  // Emphasize one thread: its text range lifts into the `on` highlight layer; its
  // element overlay takes the `on` class. Both clear first so only one is lit.
  const setOn = (id: string | null) => {
    onHl?.clear()
    for (const ov of Array.from(document.querySelectorAll(".derive-el-hl.derive-el-on")))
      ov.classList.remove("derive-el-on")
    if (!id) return
    if (onHl) for (const t of textEntries) if (t.id === id) onHl.add(t.range)
    for (const ov of Array.from(document.querySelectorAll(`.derive-el-hl[data-derive-id="${id}"]`)))
      ov.classList.add("derive-el-on")
  }

  // Flash a text range a couple of times by toggling it in the `flash` highlight
  // (::highlight can't run a keyframe animation, so we blink it in JS — element
  // overlays keep their CSS animation).
  let flashTimer = 0
  const flashRange = (range: Range) => {
    if (!flashHl) return
    if (flashTimer) clearTimeout(flashTimer)
    let n = 0
    const tick = () => {
      flashHl.clear()
      if (n % 2 === 0) flashHl.add(range)
      n++
      if (n <= 4) flashTimer = window.setTimeout(tick, 250)
      else {
        flashHl.clear()
        flashTimer = 0
      }
    }
    tick()
  }

  window.addEventListener("message", (e: MessageEvent) => {
    const d = e.data
    if (d?.source !== "derive-host") return
    if (d.type === "anchors") applyAnchors(d.anchors || [])
    else if (d.type === "remeasure") reportRects()
    else if (d.type === "emphasize") setOn(d.id)
    else if (d.type === "scroll-by") window.scrollBy(0, d.dy || 0)
    else if (d.type === "focus-anchor") {
      const entry = textEntries.find((t) => t.id === d.id)
      const ovEl = document.querySelector<HTMLElement>(`.derive-el-hl[data-derive-id="${d.id}"]`)
      const rect = entry ? entry.range.getBoundingClientRect() : ovEl?.getBoundingClientRect()
      if (!rect) return
      /* bias (0..1) places the target at that fraction of the viewport instead of
         dead-center — phones pass ~0.28 so it lands above the comments sheet. */
      const bias = typeof d.bias === "number" ? d.bias : null
      const top =
        bias != null
          ? scrollTop() + rect.top - window.innerHeight * bias
          : scrollTop() + rect.top - Math.max(0, (window.innerHeight - rect.height) / 2)
      fastScrollTo(top)
      /* text ranges flash via the flash highlight; element overlays via their class. */
      if (entry) flashRange(entry.range)
      if (ovEl) {
        ovEl.classList.remove("derive-el-flash")
        void ovEl.offsetWidth
        ovEl.classList.add("derive-el-flash")
      }
      setTimeout(reportScroll, 260) // just past fastScrollTo's 220ms
    }
  })
})()
