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
 *                  anchor-hover / cursor / cursor-tap / cursor-leave / navigate /
 *                  open-external / esc / present / edit-state / edit-edits /
 *                  edit-save / edit-blocked / edit-request / deck-sniff
 *   host → frame:  anchors / remeasure / focus-anchor / emphasize / scroll-by /
 *                  edit-mode / edit-collect / edit-restore / edit-armed /
 *                  edit-undo / edit-redo / edit-format / deck-drive
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
// `quiet` anchors (resolved threads) RESOLVE — so focus-anchor can jump to them
// and flash the context once — but never paint a persistent highlight, never
// hit-test for hover/click, and never report a top (nothing pins to them).
interface Anchor {
  id: string
  exact?: string
  prefix?: string
  suffix?: string
  slide?: number
  el?: ElWire
  quiet?: boolean
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
    if (editOn) return // editing: selections are for the caret, not the comment bar
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
    // While editing, a selection means something different: not "comment on this"
    // but "format this". The bar's B / I / link enable on it, so the state goes up
    // through the same debounce the dirty count uses.
    if (editOn) {
      const r = formattableRange()
      if (r) pendingRange = r.cloneRange()
      scheduleDirty()
      return
    }
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
      if (editOn) return
      const s = window.getSelection()
      if (s && !s.isCollapsed) {
        setTimeout(emitSelection, 0)
        return
      }
      if (tMoved) return
      const el = asEl(e.target)
      if (!el || el.closest("a,button,input,textarea,select,label,[data-derive-id]")) return
      /* a tap on a non-text media element (image/chart/video/embed) is how you anchor
         a comment to it on touch. Text-ish containers (table/pre/figure cells) still
         fall through to block-tap. */
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
  // Last pointer position (viewport px) + whether it's currently over the doc, so a SCROLL
  // with a still mouse re-broadcasts the cursor at its new document position (the content
  // under the pointer changed) — otherwise peers freeze our cursor on stale content.
  let pX = 0
  let pY = 0
  let pIn = false
  const postCursor = (type: "cursor" | "cursor-tap") => {
    const w = window.innerWidth || 1
    const dh = document.documentElement.scrollHeight || 1
    // Document-normalized: x by width, y by full doc height (incl. scroll). Each viewer maps
    // it back against their OWN scroll, so a peer sits where they are in the doc and glides.
    post({ type, x: pX / w, y: (pY + scrollTop()) / dh })
  }
  let cT = 0
  document.addEventListener("mousemove", (e) => {
    pX = e.clientX
    pY = e.clientY
    pIn = true
    const n = Date.now()
    if (n - cT < 40) return
    cT = n
    postCursor("cursor")
  })
  document.addEventListener("mousedown", (e) => {
    pX = e.clientX
    pY = e.clientY
    pIn = true
    postCursor("cursor-tap")
  })
  document.addEventListener("mouseleave", () => {
    pIn = false
    post({ type: "cursor-leave" })
  })
  window.addEventListener("blur", () => {
    pIn = false
    post({ type: "cursor-leave" })
  })
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      pIn = false
      post({ type: "cursor-leave" })
    }
  })
  /** The editable block the caret is in, if any. */
  const focusedEditable = (): HTMLElement | null => {
    if (!editOn) return null
    const el = asEl(document.activeElement)?.closest("[data-derive-editable]")
    return el instanceof HTMLElement ? el : null
  }

  /* THE KEYBOARD, and who owns it.
   *
   * Registered on `window` with CAPTURE, which is the only phase that runs before
   * the artifact's own handlers: this client is a script tag appended AFTER the
   * document, so every inline script in the page — including a deck's slide
   * switcher — registered first, and in the bubble phase registration order wins.
   *
   * While the caret sits in an editable block, the page's own shortcuts are OFF.
   * A deck binds Space, the arrows, PageUp/PageDown and Home/End to slide
   * navigation (that is what our own scaffold and authoring guide tell people to
   * write), so without this, typing a space in a headline advances the slide and
   * pressing Home jumps the deck instead of moving the caret. stopImmediatePropagation
   * hides the key from other listeners; it does NOT preventDefault, so the character
   * still types and the caret still moves. With no caret in a block, the page keeps
   * its keyboard — you can still walk to slide 7 and then click a line to edit.
   */
  const ownKeys = (e: KeyboardEvent) => {
    const focused = focusedEditable()
    if (e.type === "keydown") {
      // Save from the keyboard while editing. The keystroke happens INSIDE the frame,
      // so the host's own window listener can never see it — forward it, and swallow
      // the browser's Save-page dialog that ⌘S would otherwise open over the document.
      if (
        editOn &&
        (e.metaKey || e.ctrlKey) &&
        (e.key === "s" || e.key === "S" || e.key === "Enter")
      ) {
        e.preventDefault()
        e.stopImmediatePropagation()
        post({ type: "edit-save" })
        return
      }
      // ⌘B / ⌘I / ⌘K on a selection inside a block. The browser's own bold/italic
      // never fired here (plaintext-only contenteditable drops format commands), so
      // these keys did nothing at all in a mode that looks like a text editor.
      if (focused && (e.metaKey || e.ctrlKey) && !e.altKey) {
        const k = e.key.toLowerCase()
        // ⌘Z / ⇧⌘Z drive OUR stack, not the browser's. The native one only sees
        // typing in the block it happened in — it cannot undo a bold, a link, a
        // break, or a block put back — and two stacks that disagree about what
        // happened last are worse than one that is a little coarse.
        if (k === "z") {
          e.preventDefault()
          e.stopImmediatePropagation()
          if (e.shiftKey) redo()
          else undo()
          return
        }
        if (k === "b" || k === "i") {
          e.preventDefault()
          e.stopImmediatePropagation()
          applyFmt(k)
          return
        }
        if (k === "k") {
          e.preventDefault()
          e.stopImmediatePropagation()
          // The frame is sandboxed with allow-modals, so a prompt is available and
          // is the least ceremony for "what should this link to". The host's own
          // dialog can't reach into the selection that lives in here.
          const href = window.prompt("Link to:")?.trim()
          if (href) applyFmt("a", href)
          return
        }
      }
      if (e.key === "Escape") {
        // Two steps, deliberately. With the caret in a block, Escape drops the caret
        // and stops there — the typed text and the session both survive, which is what
        // "get this cursor out of the way" should mean. Only an Escape with no block
        // focused asks the host to leave the MODE (it exits clean, confirms dirty).
        if (focused) {
          e.stopImmediatePropagation()
          focused.blur()
          return
        }
        // Escape pressed while keyboard focus is INSIDE the frame (a click into the
        // document moves it here): the host's window listener can't see it, so
        // forward it for host-level dismissals (leaving focus mode, a composer).
        post({ type: "esc" })
        return
      }
      // `p` presents. Same reason as Escape: one click into the document moves
      // keyboard focus in here, and the host's own listener goes deaf — which is
      // exactly the moment someone reaches for the present shortcut. Forwarded, not
      // swallowed, so a deck that binds `p` itself still gets it.
      if ((e.key === "p" || e.key === "P") && !e.metaKey && !e.ctrlKey && !e.altKey && !focused)
        post({ type: "present" })
    }
    if (focused) e.stopImmediatePropagation()
  }
  // keypress/keyup too: a page that binds either would still act on a key we let
  // through here (the deck template uses keydown, but nothing makes that a rule).
  window.addEventListener("keydown", ownKeys, true)
  window.addEventListener("keypress", ownKeys, true)
  window.addEventListener("keyup", ownKeys, true)

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
    ".derive-el-outline{position:absolute;display:none;pointer-events:none;border:2px dashed rgba(100,116,139,.6);border-radius:4px;z-index:2147483639}" +
    /* inline edit mode: the block being edited carries a quiet ring; a block with
       unsaved changes keeps a faint tint so you can see what you touched. Same slate
       family as the comment highlights — one visual voice, nothing loud. */
    "[data-derive-editable]{cursor:text}" +
    "[data-derive-editable]:focus{outline:2px solid rgba(100,116,139,.6);outline-offset:3px;border-radius:3px}" +
    ".derive-edited{background-color:rgba(100,116,139,.08);border-radius:2px}" +
    /* The invitation. In edit mode the block under the pointer lifts slightly, so the
       document itself shows which runs are editable BEFORE you commit a click —
       without it, edit mode is pixel-identical to reading and you have to click
       something to discover what counts as text. Tracks exactly what a click would
       activate (same editContainerFor), so it can never promise the wrong region. */
    ".derive-edit-hover{background-color:rgba(100,116,139,.09);border-radius:3px;outline:1px solid rgba(100,116,139,.22);outline-offset:2px;cursor:text}" +
    /* ...and again derived from the block's OWN text colour, which by definition
       contrasts with whatever the artifact painted behind it. The slate wash above
       composites to ~1:1 on a dark page — invisible exactly where the invitation
       matters most. Declared second so it wins wherever color-mix is supported, and
       the rgba rule remains the fallback where it is not. */
    "@supports (color: color-mix(in srgb, currentColor 10%, transparent)){" +
    ".derive-edit-hover{background-color:color-mix(in srgb, currentColor 8%, transparent);outline-color:color-mix(in srgb, currentColor 38%, transparent)}" +
    "[data-derive-editable]:focus{outline-color:color-mix(in srgb, currentColor 70%, transparent)}" +
    "}" +
    /* Formatting applied in this session, shown as it will read once saved. These
       spans are the EDITOR's, not the document's: they carry the intent until the
       save turns them into real tags, and they never reach the stored source. */
    "[data-derive-fmt=b]{font-weight:700}" +
    "[data-derive-fmt=i]{font-style:italic}" +
    "[data-derive-fmt=a]{text-decoration:underline;text-underline-offset:2px}"
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
    if (t.closest("[data-derive-id],.derive-el-badge,a,button,input,textarea,select,label"))
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

  const textNodes = (root: Node): Text[] => {
    const w = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const p = n.parentNode ? n.parentNode.nodeName : ""
        if (p === "SCRIPT" || p === "STYLE" || p === "NOSCRIPT") return NodeFilter.FILTER_REJECT
        // Our OWN injected UI (the element-overlay badges) is not page text: it must
        // never leak into quote context windows or edit snapshots — a suffix containing
        // a badge glyph can't resolve against the stored source.
        const el = (n as Text).parentElement
        if (el?.closest?.(".derive-el-hl")) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
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
    /** Resolved thread: locatable (jump/flash) but never painted or hit-tested. */
    quiet?: boolean
  }
  let textEntries: TextEntry[] = []
  /* quiet ELEMENT anchors: resolved threads pinned to elements — tracked only so
     focus-anchor can scroll to them; no overlay, no badge. */
  let quietEls: { id: string; el: Element }[] = []
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
    quietEls = []
    baseHl?.clear()
    overlapHl?.clear()
    onHl?.clear()
    flashHl?.clear()
  }
  const addText = (id: string, range: Range, quiet?: boolean) => {
    textEntries.push({ id, range, quiet })
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
    for (const t of textEntries) if (!t.quiet) baseHl.add(t.range)
    if (overlapHl)
      for (let i = 0; i < textEntries.length; i++)
        for (let j = i + 1; j < textEntries.length; j++) {
          const a = textEntries[i]
          const b = textEntries[j]
          if (!a || !b || a.quiet || b.quiet) continue
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
    for (const { id, range, quiet } of textEntries) {
      if (quiet) continue // no visible highlight — nothing to click or hover
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
  /* ── Decks that never said so ──────────────────────────────────────────────────
     The deck protocol is opt-in: a deck posts its position and the host shows a
     presentation bar. Every deck written before that protocol existed — and every
     one written from a template that predates it — is a real deck the viewer
     treats as a flat page: no bar, no position, no Present.

     But the structure is right there, and this client already reads it to keep
     comments on the right slide. So SNIFF it: slides whose visibility is switched
     (one shown, the rest hidden) is a deck, whatever it says about itself. The host
     prefers a real protocol announcement and falls back to this, so an artifact
     that speaks for itself is never second-guessed.

     A page whose `.slide` sections are ALL visible is a long page that happens to
     use the class name — it scrolls, it doesn't switch, and driving it would be
     nonsense. Requiring at least one hidden slide is what tells the two apart. */
  const shown = (el: Element): boolean => {
    let st: CSSStyleDeclaration
    try {
      st = getComputedStyle(el)
    } catch (_e) {
      return true
    }
    if (st.display === "none" || st.visibility === "hidden") return false
    return Number(st.opacity || "1") > 0.5
  }
  /** Which slide is on screen: the `.on` convention first (what our own template and
   *  authoring guide write), else the first one that is actually painted. */
  const activeSlide = (slides: Element[]): number => {
    for (let i = 0; i < slides.length; i++)
      if ((slides[i] as Element).classList.contains("on")) return i
    for (let i = 0; i < slides.length; i++) if (shown(slides[i] as Element)) return i
    return 0
  }
  const sniffDeck = (): { i: number; total: number } | null => {
    const slides = slideEls()
    if (slides.length < 2) return null
    if (slides.every(shown)) return null
    return { i: activeSlide(slides), total: slides.length }
  }
  let lastSniff = ""
  const postDeckSniff = () => {
    const d = sniffDeck()
    if (!d) return
    const key = `${d.i}/${d.total}`
    if (key === lastSniff) return
    lastSniff = key
    post({ type: "deck-sniff", i: d.i, total: d.total })
  }
  /* Drive a sniffed deck. Synthesize the key the page already listens for rather
     than reaching into its DOM: its own handler runs, so its index, progress bar and
     counter stay consistent with what's on screen — a class we toggled ourselves
     would desync the page from itself on the very next press of its own arrow key.
     Toggling `.on` is the fallback for a deck that only wired up click zones. */
  const dispatchKey = (key: string) => {
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
    } catch (_e) {}
  }
  const driveDeck = (action: string, n?: number) => {
    const slides = slideEls()
    if (slides.length < 2) return
    const from = activeSlide(slides)
    const want = action === "next" ? from + 1 : action === "prev" ? from - 1 : (n ?? 0)
    const to = Math.max(0, Math.min(slides.length - 1, want))
    if (to === from) return
    const key = to > from ? "ArrowRight" : "ArrowLeft"
    for (let s = 0; s < Math.abs(to - from); s++) dispatchKey(key)
    requestAnimationFrame(() => {
      const now = slideEls()
      if (activeSlide(now) !== to)
        for (let i = 0; i < now.length; i++) (now[i] as Element).classList.toggle("on", i === to)
      postDeckSniff()
    })
  }
  /* A slide flip is a class or style change, which fires no scroll, resize or load —
     watch the slides themselves (bounded: one observer over the slide elements, not
     the document) so the host's position stays truthful however the page moves. */
  const watchSlides = () => {
    const slides = slideEls()
    if (slides.length < 2 || !window.MutationObserver) return
    try {
      const mo = new MutationObserver(() => {
        postDeckSniff()
        // The slide changed under an open edit session — re-mask (see below).
        if (editOn) maskOffscreenSlides()
      })
      for (const s of slides)
        mo.observe(s, { attributes: true, attributeFilter: ["class", "style"] })
    } catch (_e) {}
  }

  /* 🚨 Hidden slides still catch clicks.
     A deck stacks every slide at `inset:0` and hides the inactive ones with
     OPACITY — which removes them from view but NOT from hit testing. So a click
     aimed at the headline you can see resolves its caret in whichever slide is
     last in DOM order at that point, and you edit a slide nobody is looking at.
     Found by typing into slide 2 of a real deck and watching the text land in
     slide 3's heading.
     While editing, take every off-screen slide out of hit testing, and put each
     one back exactly as it was on the way out (a deck may set pointer-events
     itself). Text edits are built from text nodes, so this inline style can never
     reach a saved quote.

     🚨 IDEMPOTENT ON PURPOSE. Writing `style` is an attribute mutation, and the
     slide observer above watches `style` — a mask that rewrote the same value every
     pass re-triggered the observer, which re-masked, forever. The renderer spun hard
     enough that CDP input timed out, which is how it was found. So: only ever write
     when the value actually changes. */
  let slideMask: { el: HTMLElement; prev: string }[] = []
  const unmaskSlides = () => {
    for (const m of slideMask) m.el.style.pointerEvents = m.prev
    slideMask = []
  }
  const maskOffscreenSlides = () => {
    const slides = slideEls()
    if (slides.length < 2) return
    // The ACTIVE index, not per-slide visibility: a slide mid-transition is still
    // fading and would read as hidden (or as shown) depending on the frame.
    const on = activeSlide(slides)
    for (let i = 0; i < slides.length; i++) {
      const el = slides[i]
      if (!(el instanceof HTMLElement)) continue
      const masked = slideMask.find((m) => m.el === el)
      if (i === on) {
        // The slide came back on screen: give it its own value back.
        if (masked) {
          el.style.pointerEvents = masked.prev
          slideMask = slideMask.filter((m) => m.el !== el)
        }
      } else if (!masked) {
        slideMask.push({ el, prev: el.style.pointerEvents })
        el.style.pointerEvents = "none"
      }
    }
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
    for (const { id, range, quiet } of textEntries) {
      if (quiet) continue /* nothing pins to a resolved thread */
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
    /* Two independent streams to the host: comment-anchor TOPS (this message) and viewport
       GEOMETRY (reportScroll below). Keeping them separate is deliberate — tops are
       doc-absolute (scroll-invariant) and change rarely, so this dedupes on tops alone and
       an animating artifact doesn't re-render the host's comment layout every scroll frame.
       docH/viewH/scrollY ride reportScroll, which fires on every scroll/reflow/load, so the
       host's geometry (peer-cursor Y maps against it) can't go stale even with zero
       comments — the trap when geometry used to piggyback this tops-deduped message. */
    const sig = JSON.stringify(tops)
    if (sig === lastRects) return /* nothing the host pins to changed — skip the re-render */
    lastRects = sig
    post({ type: "anchor-rects", tops })
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
          /* quiet (resolved thread): track for focus-anchor only — no overlay. */
          if (a.quiet) quietEls.push({ id: a.id, el: m.el })
          else paintEl(a.id, m.el, m.band)
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
      if (range) addText(a.id, range, a.quiet)
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
        // A still pointer over the doc now hovers different content — re-broadcast so peers
        // track our cursor down the page, not just on mouse-move.
        if (pIn) postCursor("cursor")
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
      reportScroll() // geometry can change on reflow (images/fonts settle) with no scroll
    })
  }
  window.addEventListener("resize", reflow)
  /* The frame is resized when the host gives back the on-screen keyboard's height —
     which happens a beat AFTER the tap that opened it, by which time the block the
     caret is in may be behind the keyboard. revealBlock already ran (and correctly
     did nothing, the frame being full height then), so re-run it on the shrink. */
  window.addEventListener("resize", () => {
    if (!editOn) return
    const focused = asEl(document.activeElement)?.closest("[data-derive-editable]")
    if (focused instanceof HTMLElement) revealBlock(focused)
  })
  /* images/fonts settle after load — re-measure a few times so pins AND geometry land right */
  window.addEventListener("load", () => {
    const remeasure = () => {
      reportRects()
      reportScroll()
    }
    remeasure()
    setTimeout(remeasure, 400)
    setTimeout(remeasure, 1200)
    // A deck's slides only exist once its own script has run, so sniff after load
    // (and again on the settle passes, for one built by a script of its own).
    watchSlides()
    postDeckSniff()
    setTimeout(postDeckSniff, 400)
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
    if (editOn) return
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
      // Edit mode swallows the whole click grammar: no thread focusing, no link
      // navigation — a click places a caret (editClick handles link prevention).
      // The PAGE's own click handlers are stopped too: a deck's invisible left/right
      // "zones" cover the whole stage, so aiming at a headline to edit it would flip
      // the slide out from under the caret. Capture + stopImmediatePropagation is
      // what catches those, including handlers bound to the zone elements themselves.
      if (editOn) {
        e.stopImmediatePropagation()
        editClick(e)
        return
      }
      // A click on the WORDS, by someone who can edit them, is not "next slide".
      //
      // A deck's click zones cover the stage — that's how every deck we scaffold is
      // written — so the first click of a double-click flips the slide, and the
      // caret then lands on a slide the reader never meant to be on (watched it
      // happen: aim at slide 2's headline, arrive editing slide 3). For a viewer who
      // can edit, a click that lands on text belongs to the text. Everything else
      // still advances: the margins, the empty half of a title slide, links, and
      // every click by someone who can't edit this document at all.
      if (editArmed && !asEl(e.target)?.closest("a[href],a[data-derive-nav]")) {
        if (e.detail >= 2) {
          e.stopImmediatePropagation()
          return
        }
        if (slideEls().length > 1 && editNodeVisibleAt(e.clientX, e.clientY)) {
          e.stopImmediatePropagation()
          return
        }
      }
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
      extLink(e)
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
  /* Every OTHER link: never navigate the sandboxed frame itself. In-page (#)
     links and bundle-internal links (same origin, under the /raw/ serving path —
     a bundle is a whole site; its internal nav belongs in the frame) keep the
     browser default. Everything else is handed to the host, which SPA-navigates
     the app's own /artifacts/… URLs and opens the rest in a clean un-sandboxed
     tab: navigating the frame to a site that refuses framing dead-ends at
     "refused to connect", and a target=_blank popup from in here would inherit
     the sandbox. */
  const extLink = (e: MouseEvent) => {
    if (e.defaultPrevented) return
    const a = asEl(e.target)?.closest("a[href]")
    if (!a || a.hasAttribute("data-derive-nav")) return
    const href = a.getAttribute("href") || ""
    if (href.startsWith("#")) return
    let u: URL
    try {
      u = new URL(href, location.href)
    } catch {
      return
    }
    if (u.origin === location.origin) {
      if (u.pathname === location.pathname && u.hash) return
      if (u.pathname.startsWith("/raw/")) return
    }
    e.preventDefault()
    post({ type: "open-external", href: u.href })
  }
  document.addEventListener(
    "auxclick",
    (e) => {
      if (editOn) {
        // Same rule as editClick: no navigation while editing. Without this a
        // middle-click would run the browser default — opening the raw sandbox
        // origin in a tab, bypassing the host's scheme allowlist entirely.
        if (asEl(e.target)?.closest("a[href],a[data-derive-nav]")) e.preventDefault()
        return
      }
      if (e.button === 1) {
        navLink(e)
        extLink(e)
      }
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

  /* === Inline edit mode ======================================================
     Click-to-type text editing, host-driven ("edit-mode" on/off). A click lands a
     caret in the nearest text block (contenteditable, plaintext-only) — typing edits
     in place. Every enabled block snapshots its text nodes FIRST, against a whole-
     document text snapshot taken at mode entry, so on "edit-collect" each changed
     node becomes a minimal {exact, prefix, suffix, new_text} quote built from the
     PRE-EDIT text — which is what the server resolves against the stored source.
     Structure never changes here: Enter is blocked, paste is flattened to plain
     text, and a block whose element structure did change falls back to one
     whole-block span (the server refuses it if it would cross markup). */
  interface EditTarget {
    el: HTMLElement
    origHtml: string
    origValues: string[]
    origStarts: number[]
    /** Cached origValues.join("") — the dirty compare runs per keystroke tick. */
    origConcat: string
    structSig: string
  }
  let editOn = false
  /* The host says this viewer may edit (permission, current version, not already in
     the mode). It arms the in-document entry gestures — a double-click on text asks
     the host to open edit mode there — so a reader who could never save never fires
     a message, and a right-less viewer's double-click stays a plain word select. */
  let editArmed = false
  let editTargets: EditTarget[] = []
  // The pre-edit snapshot. Nodes are joined with "\n" separators (and starts offsets
  // account for them) so a prefix/suffix window crossing a node seam carries
  // whitespace there — matching the server projection, which renders a space for
  // every tag. A bare concat ("high.Set") could never context-match "high. Set".
  let editBase: { text: string; starts: Map<Text, number> } | null = null
  let lastDirty = -1
  /** Everything the edit bar reads, as one comparable string — so a mode where four
   *  things can change (dirty count, undo, redo, a live selection) still posts only
   *  when something a control would show actually moved. */
  let lastState = ""

  const structSigOf = (el: Element): string => {
    const list = el.querySelectorAll("*")
    let sig = ""
    for (let i = 0; i < list.length; i++) sig += `${(list[i] as Element).tagName},`
    return sig
  }
  const targetFor = (el: Element): EditTarget | null => {
    for (const t of editTargets) if (t.el === el) return t
    return null
  }
  const concatText = (el: Element): string => {
    let out = ""
    for (const n of textNodes(el)) out += n.nodeValue
    return out
  }
  const countDirty = () => {
    let n = 0
    for (const t of editTargets) {
      // Formatting counts even when not one character changed: bolding a word is a
      // real edit, and the text-only compare called that block clean — so Save
      // stayed hidden and the work was discardable without a warning.
      const changed = document.contains(t.el) && (concatText(t.el) !== t.origConcat || hasFmt(t.el))
      t.el.classList.toggle("derive-edited", changed)
      if (changed) n++
    }
    return n
  }
  /* ── Undo, for the whole session ──────────────────────────────────────────────
     The browser's own undo only knows typing, and only inside the one block it
     happened in: it cannot see a bold, a link, a line break, or a block someone
     put back. Two stacks that disagree is worse than one that is a little coarse,
     so the client owns ⌘Z and keeps the only stack.

     A checkpoint is the block's HTML before a discrete action. Typing checkpoints
     once per BURST (a new block, or a pause) rather than per keystroke — "undo the
     last thing you did" is what a button implies, and per-character undo through a
     round trip to the host would be neither. */
  const UNDO_LIMIT = 60
  const TYPING_BURST_MS = 900
  let undoStack: { el: HTMLElement; html: string }[] = []
  let redoStack: { el: HTMLElement; html: string }[] = []
  let lastBurst: { el: HTMLElement; at: number } | null = null
  const checkpoint = (el: HTMLElement) => {
    undoStack.push({ el, html: el.innerHTML })
    if (undoStack.length > UNDO_LIMIT) undoStack.shift()
    // A new action forks the timeline: whatever was undone is no longer ahead of us.
    redoStack = []
  }
  /** Checkpoint at the start of a typing burst, never mid-word. */
  const checkpointTyping = (el: HTMLElement) => {
    const now = Date.now()
    if (lastBurst && lastBurst.el === el && now - lastBurst.at < TYPING_BURST_MS) {
      lastBurst.at = now
      return
    }
    lastBurst = { el, at: now }
    checkpoint(el)
  }
  /* Restoring a block's HTML replaces its text nodes with new objects. A block that
     is ALREADY an edit target is fine (activation only consults the snapshot map when
     it arms a block for the first time), but re-registering when the shape matches
     keeps the aligned per-node diff available instead of falling back to a whole-block
     span — the same care restoreEdits takes for Discard. */
  const reregister = (t: EditTarget | null, el: HTMLElement) => {
    if (!t || !editBase) return
    const fresh = textNodes(el)
    if (fresh.length !== t.origValues.length) return
    for (let i = 0; i < fresh.length; i++)
      editBase.starts.set(fresh[i] as Text, t.origStarts[i] as number)
  }
  const stepHistory = (from: typeof undoStack, to: typeof undoStack) => {
    const entry = from.pop()
    if (!entry || !document.contains(entry.el)) return
    to.push({ el: entry.el, html: entry.el.innerHTML })
    entry.el.innerHTML = entry.html
    reregister(targetFor(entry.el), entry.el)
    lastBurst = null
    postDirty()
  }
  const undo = () => stepHistory(undoStack, redoStack)
  const redo = () => stepHistory(redoStack, undoStack)

  /** Is there a selection the format verbs could act on — one run, inside one
   *  editable block? The bar's B / I / link enable on exactly this. */
  const formattableRange = (): Range | null => {
    if (!editOn) return null
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null
    const r = sel.getRangeAt(0)
    const n = r.commonAncestorContainer
    const el = n.nodeType === 1 ? (n as Element) : n.parentElement
    return el?.closest("[data-derive-editable]") ? r : null
  }
  /* The range the format verbs will use. Kept because clicking a button in the HOST
     moves focus out of this frame, and the link flow then asks for a URL up there —
     by the time the answer comes back the live selection may be gone. */
  let pendingRange: Range | null = null

  const postDirty = () => {
    const n = countDirty()
    const canFormat = !!formattableRange()
    const state = `${n}|${undoStack.length > 0}|${redoStack.length > 0}|${canFormat}`
    if (state !== lastState) {
      lastState = state
      lastDirty = n
      post({
        type: "edit-state",
        dirty: n,
        canUndo: undoStack.length > 0,
        canRedo: redoStack.length > 0,
        canFormat,
      })
    }
  }
  let dirtyT = 0
  const scheduleDirty = () => {
    if (dirtyT) clearTimeout(dirtyT)
    dirtyT = window.setTimeout(postDirty, 120)
  }

  /* The hover invitation: the block a click WOULD activate, lit as the pointer moves.
     Same resolver as editClick, so what lights up is exactly what becomes editable. */
  let editHoverEl: HTMLElement | null = null
  const setEditHover = (el: HTMLElement | null) => {
    if (el === editHoverEl) return
    editHoverEl?.classList.remove("derive-edit-hover")
    editHoverEl = el
    el?.classList.add("derive-edit-hover")
  }

  /** Which gesture asked the mode to open: the double-click whose target this client
   *  already captured, or the host's Edit verb on the live selection. */
  type EditEntry = { fromPointer?: boolean; fromSelection?: boolean }
  const setEditMode = (on: boolean, keep?: boolean, entry?: EditEntry) => {
    if (on === editOn) return
    editOn = on
    if (on) {
      // The pre-edit snapshot every quote is built from. normalize() first so the
      // per-node offsets recorded at enable time can't be split later by typing.
      // "\n" between nodes: every node seam is a tag boundary in the source, which
      // the server projection renders as a space — the separator makes context
      // windows sliced across seams whitespace-flexible-matchable there.
      ;(document.body || document.documentElement).normalize()
      const nodes = textNodes(document.body)
      const starts = new Map<Text, number>()
      let full = ""
      for (const n of nodes) {
        starts.set(n, full.length)
        full += `${n.nodeValue}\n`
      }
      editBase = { text: full, starts }
      setHover(null)
      // Off-screen slides stop catching clicks meant for the slide on screen.
      maskOffscreenSlides()
      // Entered FROM the document (a double-click, or Edit on a selection): land the
      // caret where the user pointed instead of making them click the same words a
      // second time. Deferred a frame so the host's chrome has settled and the
      // block's rect is final before revealBlock measures it.
      if (entry)
        requestAnimationFrame(() => {
          if (!editOn) return
          if (entry.fromPointer) {
            // Captured by the double-click that asked for the mode. Stale means the
            // host answered something else (or much later); ignore rather than
            // arming a block the user has forgotten about.
            const p = pendingEntry
            pendingEntry = null
            if (p && Date.now() - p.at < 5000 && p.node.isConnected) editActivate(p.node, p.caret)
            return
          }
          const s = window.getSelection()
          const n = s && s.rangeCount > 0 ? s.getRangeAt(0).startContainer : null
          if (n && n.nodeType === 3) editActivate(n as Text, null)
        })
    } else {
      // `keep`: drop the editing chrome but leave the typed text standing. Used right
      // after a PUBLISH — the text on screen is what was just saved, and the version
      // swap will reload the frame a moment later; restoring here would flash the
      // pre-edit wording in between and make a successful save look like it failed.
      if (keep) settleEdits()
      else restoreEdits()
      editBase = null
      setEditHover(null)
      unmaskSlides()
      // History belongs to the session that made it. Carrying it across would offer
      // to undo into a document that has already been saved and reloaded.
      undoStack = []
      redoStack = []
      lastBurst = null
      pendingRange = null
      lastState = ""
    }
  }
  const disableTarget = (t: EditTarget) => {
    t.el.removeAttribute("contenteditable")
    t.el.removeAttribute("data-derive-editable")
    t.el.classList.remove("derive-edited")
    t.el.classList.remove("derive-edit-hover")
  }
  /** Leave the text exactly as typed; just remove the editing chrome. */
  const settleEdits = () => {
    for (const t of editTargets) if (document.contains(t.el)) disableTarget(t)
    editTargets = []
    if (lastDirty !== 0) {
      lastDirty = 0
      post({ type: "edit-state", dirty: 0 })
    }
  }
  const restoreEdits = () => {
    for (const t of editTargets) {
      if (document.contains(t.el)) {
        if (concatText(t.el) !== t.origConcat) {
          t.el.innerHTML = t.origHtml
          // innerHTML rebuilt the block's text nodes as NEW objects — re-register
          // them at their original offsets, or a Discarded block would refuse every
          // later click as "dynamic" (its nodes missing from the mode-entry map).
          if (editBase) {
            const fresh = textNodes(t.el)
            if (fresh.length === t.origValues.length)
              for (let i = 0; i < fresh.length; i++)
                editBase.starts.set(fresh[i] as Text, t.origStarts[i] as number)
          }
        }
        disableTarget(t)
      }
    }
    editTargets = []
    if (lastDirty !== 0) {
      lastDirty = 0
      post({ type: "edit-state", dirty: 0 })
    }
  }

  /* The element a caret click should edit: the nearest block-ish ancestor of the
     clicked text node — a known text block if one is close, else the first
     non-inline ancestor — capped so a page-wide wrapper never becomes one giant
     editable surface. */
  const editContainerFor = (node: Text): HTMLElement | null => {
    const parent = node.parentElement
    if (!parent) return null
    const block = parent.closest(BLOCKS)
    let cand: HTMLElement | null = block instanceof HTMLElement ? block : null
    if (!cand) {
      let el: HTMLElement | null = parent
      while (el && el !== document.body) {
        let disp = ""
        try {
          disp = getComputedStyle(el).display
        } catch (_e) {}
        if (!(disp.indexOf("inline") === 0 || disp === "contents")) {
          cand = el
          break
        }
        el = el.parentElement
      }
      if (!cand || cand === document.body) cand = parent
    }
    // A huge container (a whole-page div) would make one giant editable region —
    // step back down toward the clicked node until the text is a block's worth.
    if ((cand.textContent || "").length > 2400) {
      let small: HTMLElement = parent
      while (
        small.parentElement &&
        small.parentElement !== cand &&
        (small.parentElement.textContent || "").length <= 2400
      )
        small = small.parentElement
      cand = small
    }
    return cand
  }
  const BLOCKED_EDIT = "input,textarea,select,button,video,audio,canvas,svg,iframe,embed,object"
  /* Arm the block containing `node` and put the caret in it. Shared by the click
     inside the mode and by the ENTRY gestures (double-click, the host's Edit verb),
     so what a double-click opens is exactly what a click would have activated.
     `caret` is where to land when there is nothing better; it is IGNORED when the
     caller already made a selection worth keeping (a double-click just selected a
     word, and collapsing that would break the most natural typo gesture there is:
     double-click the word, type the fix). */
  const editActivate = (node: Text, caret: { node: Node; offset: number } | null): void => {
    const base = editBase
    if (!base) return
    const cand = editContainerFor(node)
    if (!cand) return
    // Belt and braces for the hidden-slide trap (see maskOffscreenSlides): if a
    // click still resolves into a slide that isn't the one on screen, say so
    // rather than putting a caret somewhere the typist can't see.
    const slides = slideEls()
    if (slides.length > 1) {
      const where = slideOfEl(cand, slides)
      if (where != null && where !== activeSlide(slides)) {
        post({ type: "edit-blocked", reason: "offscreen" })
        return
      }
    }
    let target = targetFor(cand)
    if (!target) {
      cand.normalize()
      const nodes = textNodes(cand)
      if (!nodes.length) return
      const origStarts: number[] = []
      for (const n of nodes) {
        const s = base.starts.get(n)
        if (s === undefined) {
          // This part of the page was re-rendered by its own script after the
          // snapshot — its text can't be mapped back to the stored source.
          post({ type: "edit-blocked", reason: "dynamic" })
          return
        }
        origStarts.push(s)
      }
      const origValues = nodes.map((n) => n.nodeValue ?? "")
      target = {
        el: cand,
        origHtml: cand.innerHTML,
        origValues,
        origStarts,
        origConcat: origValues.join(""),
        structSig: structSigOf(cand),
      }
      editTargets.push(target)
      cand.setAttribute("data-derive-editable", "1")
      // plaintext-only keeps typing and paste to bare text; fall back to true where
      // unsupported (beforeinput below still blocks structure).
      cand.setAttribute("contenteditable", "plaintext-only")
      if (cand.contentEditable !== "plaintext-only") cand.setAttribute("contenteditable", "true")
    }
    // Snapshot the selection BEFORE focus: turning an ancestor contenteditable and
    // focusing it can drop a selection made while the block was still inert, which
    // is exactly the double-click-to-edit case (the word is selected, then the host
    // round-trip arms the block).
    const sel2 = window.getSelection()
    const keep =
      sel2 && sel2.rangeCount > 0 && !sel2.isCollapsed ? sel2.getRangeAt(0).cloneRange() : null
    target.el.focus({ preventScroll: true })
    if (keep && target.el.contains(keep.commonAncestorContainer)) {
      try {
        sel2?.removeAllRanges()
        sel2?.addRange(keep)
      } catch (_e) {}
    } else if (sel2 && caret && (sel2.isCollapsed || sel2.rangeCount === 0)) {
      try {
        const r = document.createRange()
        r.setStart(caret.node, Math.min(caret.offset, node.nodeValue?.length ?? 0))
        r.collapse(true)
        sel2.removeAllRanges()
        sel2.addRange(r)
      } catch (_e) {}
    }
    setEditHover(null) // it's the focused block now; the focus ring speaks for it
    revealBlock(target.el)
  }
  /** The text node a point resolves to, or null where editing can't reach. */
  const editNodeAt = (
    x: number,
    y: number,
  ): { node: Text; caret: { node: Node; offset: number } } | null => {
    const c = caretAt(x, y)
    return c && c.node.nodeType === 3 ? { node: c.node as Text, caret: c } : null
  }
  /* The same question, asked through whatever is lying on top of the text.
     Caret hit-testing returns the TOPMOST element at a point, and a deck covers its
     stage with invisible click-catchers ("next slide" / "previous slide" zones), so
     aiming at a headline resolves the zone and editing finds nothing to edit. Peel:
     take the top element out of hit testing, ask again, repeat a few times, and put
     every one of them back. Bounded to four layers — past that, whatever is up there
     is the page's own UI and a click belongs to it.
     Off-screen slides are masked for the same reason (they are stacked at inset:0
     and stay hit-testable at opacity 0), so this resolves the text a reader can
     actually see. */
  const editNodeVisibleAt = (
    x: number,
    y: number,
  ): { node: Text; caret: { node: Node; offset: number } } | null => {
    const peeled: { el: HTMLElement; prev: string }[] = []
    const maskedHere = !editOn
    if (maskedHere) maskOffscreenSlides()
    try {
      for (let pass = 0; pass < 4; pass++) {
        const hit = editNodeAt(x, y)
        if (hit) return hit
        const top = document.elementFromPoint(x, y)
        if (
          !(top instanceof HTMLElement) ||
          top === document.body ||
          top === document.documentElement
        )
          return null
        peeled.push({ el: top, prev: top.style.pointerEvents })
        top.style.pointerEvents = "none"
      }
      return null
    } finally {
      for (const p of peeled) p.el.style.pointerEvents = p.prev
      if (maskedHere) unmaskSlides()
    }
  }
  /** An image under the pointer — the one editable thing here that isn't text. */
  const imageAt = (e: MouseEvent): HTMLImageElement | null => {
    const el = asEl(e.target)?.closest("img")
    return el instanceof HTMLImageElement ? el : null
  }
  const editClick = (e: MouseEvent) => {
    if (!editBase) return
    // A keyboard-synthesized click (Enter/Space on a focused link) reports
    // clientX/clientY 0, which would resolve a caret at the frame's top-left and
    // silently arm an unrelated block. Editing is pointer-driven; ignore it.
    if (e.detail === 0 && e.clientX === 0 && e.clientY === 0) return
    const el0 = asEl(e.target)
    // Never navigate while editing — a click on a link edits its text instead.
    if (el0?.closest("a[href],a[data-derive-nav]")) e.preventDefault()
    // A picture. Nothing in the caret path can reach one (images hold no text), so
    // clicking a picture in edit mode used to do nothing at all and the only way to
    // change one was the source editor. Hand it to the host: pick a file, upload,
    // swap the URL. A data: URI is refused — the picture IS the source there, and
    // there is no URL to swap for a person to recognise.
    const img = imageAt(e)
    if (img) {
      const src = img.getAttribute("src") || ""
      if (!src || src.slice(0, 5).toLowerCase() === "data:")
        post({ type: "edit-blocked", reason: "embedded-image" })
      else post({ type: "edit-image", src, alt: img.getAttribute("alt") || "" })
      return
    }
    if (el0?.closest(BLOCKED_EDIT)) {
      post({ type: "edit-blocked", reason: "control" })
      return
    }
    const hit = editNodeVisibleAt(e.clientX, e.clientY)
    if (!hit) return
    // A double/triple click carries its own selection; editActivate keeps it.
    editActivate(hit.node, e.detail <= 1 ? hit.caret : null)
  }

  /* Focus follows the WORDS, not what's lying on top of them.
     Focus moves on mousedown, before any click handler runs, and it moves to the
     element actually hit — which over a deck is the invisible click zone, not the
     heading beneath it. So the block was armed and immediately un-focused, and
     typing went nowhere (the caret was in the block; the focus was on the body).
     Taking the default away when an overlay is between the pointer and the text
     leaves focus where the caret is going. Only in edit mode, and only when
     something IS in the way — an ordinary click on ordinary text keeps every
     native behaviour, including drag-select. */
  document.addEventListener(
    "mousedown",
    (e) => {
      if (!editOn) return
      const hit = editNodeVisibleAt(e.clientX, e.clientY)
      if (!hit) return
      const top = document.elementFromPoint(e.clientX, e.clientY)
      if (top && !top.contains(hit.node)) e.preventDefault()
    },
    true,
  )

  /* THE WAY IN, from the document itself. Double-click any text and the host opens
     edit mode with the caret already in that block — the mode used to be reachable
     only from a button in the header, which is nowhere near the sentence you came to
     fix. Only armed for a viewer who can actually save (the host says so), and only
     where a click would have landed a caret anyway, so a double-click that lands on
     a control or on a viewer's read-only page stays an ordinary word select.

     The TEXT NODE is captured here, not the coordinates. Opening the mode adds a
     band above the document, which resizes this frame — and a deck centres its
     stage in whatever height it gets, so by the time the mode is open the words
     that were under the pointer have moved. Re-resolving a point after that lands
     the caret near the text, or in the gap beside it. A node reference survives the
     reflow; the offset within it is still the character the user aimed at. */
  let pendingEntry: {
    node: Text
    caret: { node: Node; offset: number } | null
    at: number
  } | null = null
  document.addEventListener(
    "dblclick",
    (e) => {
      if (editOn || !editArmed) return
      const el0 = asEl(e.target)
      if (el0?.closest(BLOCKED_EDIT)) return
      const hit = editNodeVisibleAt(e.clientX, e.clientY)
      if (!hit) return
      pendingEntry = { node: hit.node, caret: hit.caret, at: Date.now() }
      post({ type: "edit-request" })
    },
    true,
  )

  /* Bring the block being edited into view. On a phone the host shrinks the frame by
     the keyboard's height, so "visible" here already means "above the keyboard" —
     which is the only reason a tap near the bottom of the screen doesn't put the
     caret somewhere the typist can't see. Only scrolls when the block is actually
     clipped, so an ordinary click on a comfortably-visible paragraph never moves
     the page under the reader. */
  const revealBlock = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    const vh = window.innerHeight || document.documentElement.clientHeight
    if (r.top >= 8 && r.bottom <= vh - 8) return
    // Same answer fastScrollTo gives: an OS-level motion preference outranks the
    // nicety of an animated scroll.
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    try {
      el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" })
    } catch (_e) {
      el.scrollIntoView()
    }
  }

  /* Light the block under the pointer while editing. Throttled like the comment
     hit-test, and skipped over controls/media that can't be edited anyway, so the
     invitation never appears where a click would be refused. */
  let editHoverTick = 0
  document.addEventListener("mousemove", (e) => {
    if (!editOn || editHoverTick) return
    const x = e.clientX
    const y = e.clientY
    const target = e.target
    editHoverTick = window.setTimeout(() => {
      editHoverTick = 0
      if (!editOn) return setEditHover(null)
      if (asEl(target)?.closest(BLOCKED_EDIT)) return setEditHover(null)
      // An image lights up too: a click on one starts a replacement, and the
      // invitation is the only thing that says so.
      const overImg = asEl(target)?.closest("img")
      if (overImg instanceof HTMLElement) return setEditHover(overImg)
      // Through overlays, like the click that follows it — otherwise a deck's click
      // zone means the hover invitation never lights the block a click would open.
      const hit = editNodeVisibleAt(x, y)
      if (!hit) return setEditHover(null)
      const cand = editContainerFor(hit.node)
      // A block that's already editable wears the focus ring; don't double-decorate.
      setEditHover(cand && !cand.hasAttribute("data-derive-editable") ? cand : null)
    }, 50)
  })
  document.addEventListener("mouseleave", () => setEditHover(null))

  document.addEventListener(
    "beforeinput",
    (e: InputEvent) => {
      if (!editOn) return
      const t = asEl(e.target)?.closest("[data-derive-editable]")
      if (!t) return
      const it = e.inputType || ""
      // Before the mutation, not after: this is the only place we can capture what
      // the block looked like a keystroke ago.
      if (t instanceof HTMLElement) checkpointTyping(t)
      // Enter breaks the line. Blocking it outright made the mode feel broken —
      // pressing Enter mid-sentence is reflexive — while a real paragraph SPLIT
      // stays out: that changes the document's structure, and this editor only ever
      // rewrites the inside of one block. The break rides the same editor-span
      // grammar as bold and italic and becomes a <br> on save.
      if (it === "insertParagraph" || it === "insertLineBreak") {
        e.preventDefault()
        insertBreak()
        return
      }
      // Formatting commands (⌘B and friends) don't reach a plaintext-only field
      // anyway; the client applies its own (see applyFmt).
      if (it.indexOf("format") === 0) {
        e.preventDefault()
        return
      }
      // Paste flattens to plain text (newlines become spaces) whatever the source.
      if (it === "insertFromPaste" || it === "insertFromDrop") {
        e.preventDefault()
        const raw = e.dataTransfer?.getData("text/plain") ?? (e.data != null ? String(e.data) : "")
        const plain = raw.replace(/\s+/g, " ")
        if (plain) document.execCommand("insertText", false, plain)
      }
    },
    true,
  )
  document.addEventListener("input", (e) => {
    if (!editOn) return
    if (!asEl(e.target)?.closest("[data-derive-editable]")) return
    // Tell the host it is dirty on the FIRST keystroke, before the debounce. The
    // exact count can wait 120ms; the fact that there is unsaved work cannot — the
    // host's unsaved-work guard is armed by this number, and typing then
    // immediately hitting Escape or a link inside that window dropped the edit
    // silently. An optimistic 1 is corrected by the settled count either way.
    if (lastDirty <= 0) {
      lastDirty = 1
      post({ type: "edit-state", dirty: 1 })
    }
    scheduleDirty()
  })

  /* ── Bold, italic, link ───────────────────────────────────────────────────────
     Everything else in this mode is plain text by design: the contenteditable is
     `plaintext-only`, and the server escapes every replacement. Formatting is the
     one exception, and it is deliberately narrow — emphasis and a link, on a run of
     words inside one block.

     The wrap is the EDITOR's, not the document's: a `[data-derive-fmt]` span holds
     the intent (and shows what it will look like) until the save turns it into a
     real tag. Nothing here touches the stored source; `collectEdits` reads these
     spans and sends the block as one `new_html` edit, which the server sanitizes
     down to five inline tags.

     ⌘B/⌘I/⌘K, because those are the keys every writing tool binds. The frame owns
     the keyboard while a caret is in a block, so they can't reach the browser. */
  const FMT_ATTR = "data-derive-fmt"
  const HREF_ATTR = "data-derive-href"
  const applyFmt = (kind: "b" | "i" | "a", href?: string): void => {
    // The live selection, or the one stashed when the bar's button took focus out of
    // this frame (the link flow asks for a URL up in the host, and the answer arrives
    // after the selection here has gone).
    const live = formattableRange()
    const range =
      live ?? (pendingRange && pendingRange.startContainer.isConnected ? pendingRange : null)
    pendingRange = null
    if (!range) {
      post({ type: "edit-blocked", reason: "format-empty" })
      return
    }
    const anchor = range.commonAncestorContainer
    const el = anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement
    const block = el?.closest("[data-derive-editable]")
    if (!(block instanceof HTMLElement)) {
      post({ type: "edit-blocked", reason: "format-outside" })
      return
    }
    checkpoint(block)
    const span = document.createElement("span")
    span.setAttribute(FMT_ATTR, kind)
    if (href) span.setAttribute(HREF_ATTR, href)
    try {
      // Throws when the selection only half-contains an element — exactly the case
      // we can't express as one inline run, so the refusal is the right answer.
      range.surroundContents(span)
    } catch (_e) {
      // The checkpoint was for an action that didn't happen — drop it, or Undo would
      // have a step that changes nothing.
      undoStack.pop()
      post({ type: "edit-blocked", reason: "format-range" })
      return
    }
    window.getSelection()?.removeAllRanges()
    scheduleDirty()
  }
  /** Enter: a line break at the caret, carried by the same editor span the other
   *  formatting uses (so one collect path handles all of it) and rendered by the
   *  real <br> inside it, so the line breaks on screen the moment it's typed. */
  const insertBreak = (): void => {
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) return
    const range = sel.getRangeAt(0)
    const el = range.startContainer
    const block = (el.nodeType === 1 ? (el as Element) : el.parentElement)?.closest(
      "[data-derive-editable]",
    )
    if (!(block instanceof HTMLElement)) return
    checkpoint(block)
    const span = document.createElement("span")
    span.setAttribute(FMT_ATTR, "br")
    span.appendChild(document.createElement("br"))
    range.deleteContents()
    range.insertNode(span)
    // Caret after the break, so typing continues on the new line.
    range.setStartAfter(span)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
    scheduleDirty()
  }

  /** Serialize a block as inline markup: text escaped, editor spans as real tags,
   *  anything else contributing its text only (the server refuses a span that
   *  crosses the document's own markup anyway, and this keeps that refusal clean). */
  const serializeFmt = (el: Node): string => {
    let out = ""
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        out += escapeText(n.nodeValue ?? "")
        continue
      }
      if (n.nodeType !== 1) continue
      const e = n as Element
      const kind = e.getAttribute(FMT_ATTR)
      const inner = serializeFmt(e)
      if (kind === "b") out += `<b>${inner}</b>`
      else if (kind === "i") out += `<i>${inner}</i>`
      else if (kind === "br") out += "<br>"
      else if (kind === "a")
        out += `<a href="${escapeText(e.getAttribute(HREF_ATTR) || "")}">${inner}</a>`
      else out += inner
    }
    return out
  }
  const escapeText = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  const hasFmt = (el: Element): boolean => !!el.querySelector(`[${FMT_ATTR}]`)

  const isHiSur = (ch: string | undefined): boolean =>
    !!ch && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdbff
  const isLoSur = (ch: string | undefined): boolean =>
    !!ch && ch.charCodeAt(0) >= 0xdc00 && ch.charCodeAt(0) <= 0xdfff

  /* One changed text run → a quote edit built from the PRE-EDIT document text.
     Minimal diff (common prefix/suffix), then snapped OUT to word boundaries: the
     matcher's context join expects whitespace between prefix|exact|suffix, and whole
     words give the exact enough meat to be unambiguous. */
  const quoteEditFor = (
    orig: string,
    cur: string,
    docStart: number,
  ): { exact: string; prefix: string; suffix: string; new_text: string } | null => {
    const base = editBase
    if (!base) return null
    let p = 0
    const maxP = Math.min(orig.length, cur.length)
    while (p < maxP && orig[p] === cur[p]) p++
    if (isHiSur(orig[p - 1])) p--
    let s = 0
    const maxS = Math.min(orig.length, cur.length) - p
    while (s < maxS && orig[orig.length - 1 - s] === cur[cur.length - 1 - s]) s++
    if (isLoSur(orig[orig.length - s])) s--
    // Word-snap: widen the changed span to whole words on both sides.
    while (p > 0 && !/\s/.test(orig[p - 1] as string)) p--
    let end = orig.length - s
    while (end < orig.length && !/\s/.test(orig[end] as string)) end++
    s = orig.length - end
    let exact = orig.slice(p, end)
    let newText = cur.slice(p, cur.length - s)
    // A whitespace-only difference has no rendered effect — not worth a version.
    if (!exact.trim() && !newText.trim()) return null
    if (!exact.trim()) {
      // Pure insertion between whitespace: fold in the neighboring word (left if
      // there is one, else right) so the exact has something to anchor on.
      if (!orig.trim()) return null
      if (p > 0) {
        while (p > 0 && /\s/.test(orig[p - 1] as string)) p--
        while (p > 0 && !/\s/.test(orig[p - 1] as string)) p--
      } else {
        while (end < orig.length && /\s/.test(orig[end] as string)) end++
        while (end < orig.length && !/\s/.test(orig[end] as string)) end++
        s = orig.length - end
      }
      exact = orig.slice(p, end)
      newText = cur.slice(p, cur.length - s)
      if (!exact.trim()) return null
    }
    return {
      exact,
      prefix: base.text.slice(Math.max(0, docStart + p - 40), docStart + p),
      suffix: base.text.slice(docStart + end, docStart + end + 40),
      new_text: newText,
    }
  }
  /** The wire shape of one collected edit: text, or (formatting only) markup. */
  interface WireEdit {
    quote: { exact: string; prefix: string; suffix: string }
    new_text?: string
    new_html?: string
  }
  const wireEdit = (qe: {
    exact: string
    prefix: string
    suffix: string
    new_text: string
  }): WireEdit => ({
    quote: { exact: qe.exact, prefix: qe.prefix, suffix: qe.suffix },
    new_text: qe.new_text,
  })
  /* A block someone formatted goes as ONE markup edit for the whole block, not a
     per-run diff. Two reasons: the wrap splits text nodes, so the per-node
     alignment the text path depends on is gone; and a bold run's boundaries are
     only meaningful together with the words around them. The quote is the block's
     PRE-edit text (which is what the stored source still holds), so a block that
     already contains markup is refused by the server's tag-crossing guard rather
     than mangled here — with a message that names the source editor. */
  const blockHtmlEdit = (t: EditTarget): WireEdit | null => {
    const base = editBase
    if (!base) return null
    const exact = t.origValues.join("\n")
    if (!exact.trim()) return null
    const start = t.origStarts[0] ?? 0
    const end = start + exact.length
    return {
      quote: {
        exact,
        prefix: base.text.slice(Math.max(0, start - 40), start),
        suffix: base.text.slice(end, end + 40),
      },
      new_html: serializeFmt(t.el).replace(/\s*\n\s*/g, " "),
    }
  }
  // The whole-block span: both sides joined with the same "\n" separators the
  // snapshot uses, so offsets line up with editBase.text; the replacement's seam
  // separators collapse to single spaces (typed content never contains newlines —
  // Enter is blocked and paste is flattened).
  const blockEdit = (t: EditTarget, curVals: string[]): WireEdit | null => {
    const qe = quoteEditFor(t.origValues.join("\n"), curVals.join("\n"), t.origStarts[0] ?? 0)
    return qe ? wireEdit({ ...qe, new_text: qe.new_text.replace(/\s*\n\s*/g, " ") }) : null
  }
  /* `uncaptured` counts blocks the user changed that produced NO edit — the host
     refuses to save a partial batch, because publishing some of the typing and
     letting the post-save reload wipe the rest is data loss dressed up as success.
     Only the all-or-nothing case used to be detectable (edits empty while dirty), so
     one lost block among several good ones went out silently. */
  const collectEdits = (): { edits: WireEdit[]; dirty: number; uncaptured: number } => {
    const edits: WireEdit[] = []
    let dirty = 0
    let uncaptured = 0
    for (const t of editTargets) {
      if (!document.contains(t.el)) continue
      // A formatted block is markup, whole. Checked BEFORE normalize(), which would
      // merge the text either side of a wrap and lose nothing — but the html path
      // doesn't need the per-node alignment normalize() exists to protect.
      if (hasFmt(t.el)) {
        dirty++
        const he = blockHtmlEdit(t)
        if (he) edits.push(he)
        else uncaptured++
        continue
      }
      t.el.normalize()
      const curNodes = textNodes(t.el)
      const curVals = curNodes.map((n) => n.nodeValue ?? "")
      if (curVals.join("") === t.origConcat) continue
      dirty++
      const aligned = curVals.length === t.origValues.length && structSigOf(t.el) === t.structSig
      if (aligned) {
        // Per-node minimal edits — but if ANY changed node can't be captured (a
        // whitespace-only node someone typed into has nothing to anchor on), fall
        // back to one whole-block span rather than silently dropping that change.
        const nodeEdits: WireEdit[] = []
        let unrepresentable = false
        for (let i = 0; i < curVals.length; i++) {
          const o = t.origValues[i] as string
          const cNew = curVals[i] as string
          if (o === cNew) continue
          const qe = quoteEditFor(o, cNew, t.origStarts[i] as number)
          if (qe) nodeEdits.push(wireEdit(qe))
          else unrepresentable = true
        }
        if (!unrepresentable) {
          edits.push(...nodeEdits)
          continue
        }
      }
      // Structure changed, or a per-node edit was unrepresentable: one whole-block
      // span. The server refuses it if the span would cross markup in the source.
      const be = blockEdit(t, curVals)
      if (be) edits.push(be)
      else uncaptured++
    }
    return { edits, dirty, uncaptured }
  }

  window.addEventListener("message", (e: MessageEvent) => {
    const d = e.data
    if (d?.source !== "derive-host") return
    if (d.type === "anchors") applyAnchors(d.anchors || [])
    else if (d.type === "remeasure") reportRects()
    else if (d.type === "emphasize") setOn(d.id)
    else if (d.type === "edit-mode")
      setEditMode(
        !!d.on,
        !!d.keep,
        d.fromPointer || d.fromSelection
          ? { fromPointer: !!d.fromPointer, fromSelection: !!d.fromSelection }
          : undefined,
      )
    else if (d.type === "edit-armed") editArmed = !!d.on
    // The edit bar's controls, driven from the host. Same functions the keyboard
    // chords call, so a button and its shortcut can never mean different things.
    else if (d.type === "edit-undo") undo()
    else if (d.type === "edit-redo") redo()
    else if (d.type === "edit-format")
      applyFmt(
        d.kind === "i" ? "i" : d.kind === "a" ? "a" : "b",
        typeof d.href === "string" ? d.href : undefined,
      )
    // Only sent to a SNIFFED deck: one that speaks the protocol is driven by its own
    // `deck` message, which it answers itself.
    else if (d.type === "deck-drive") driveDeck(String(d.action || ""), d.n)
    else if (d.type === "edit-collect") {
      // The nonce rides back untouched: a slow page can answer a TIMED-OUT collect
      // after the host started a new one, and stale edits must not resolve it.
      const { edits, dirty, uncaptured } = collectEdits()
      post({ type: "edit-edits", edits, dirty, uncaptured, nonce: d.nonce })
    } else if (d.type === "edit-restore") restoreEdits()
    else if (d.type === "scroll-by") window.scrollBy(0, d.dy || 0)
    else if (d.type === "focus-anchor") {
      const entry = textEntries.find((t) => t.id === d.id)
      const ovEl = document.querySelector<HTMLElement>(`.derive-el-hl[data-derive-id="${d.id}"]`)
      /* quiet element anchors have no overlay — the element itself carries the rect. */
      const quietEl = quietEls.find((q) => q.id === d.id)
      const rect = entry
        ? entry.range.getBoundingClientRect()
        : (ovEl ?? quietEl?.el)?.getBoundingClientRect()
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
