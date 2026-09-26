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
 *                  edit-save / edit-blocked / edit-image /
 *                  edit-mention-query / edit-mention-key / deck-sniff
 *   host → frame:  anchors / remeasure / focus-anchor / emphasize / scroll-by /
 *                  edit-mode / edit-collect / edit-restore /
 *                  edit-undo / edit-redo / edit-format / edit-mention-insert /
 *                  edit-mention-close / deck-drive
 *
 * Keep its imports DOM-free + pure so it bundles into one small self-contained script.
 */

import {
  BLOCK_TEXT_ELEMENTS,
  findQuoteMatches,
  findQuoteWithContext,
  fingerprintFrom,
  normWs,
} from "./anchor-shared"
import {
  isMentionHandle,
  MENTION_NON_PROSE_SELECTOR,
  mentionQueryAtEnd,
  mentionTokens,
} from "./mention-shared"
import {
  collectSourceOps,
  FMT_ATTR,
  GEN_ATTR,
  HREF_ATTR,
  releaseSource,
  SRC_ATTR,
  type SrcSnapshot,
  snapshotSource,
  srcOf,
} from "./source-tokens"
import {
  MAX_STRUCTURAL_HEIGHT_PX,
  MAX_STRUCTURAL_WIDTH_PCT,
  MIN_STRUCTURAL_HEIGHT_PX,
  MIN_STRUCTURAL_WIDTH_PCT,
  STRUCTURAL_ALIGN_PROPERTY,
  STRUCTURAL_GAP_PROPERTY,
  STRUCTURAL_HEIGHT_PROPERTY,
  STRUCTURAL_LAYOUT,
  STRUCTURAL_WIDTH_PROPERTY,
} from "./structural-width"
import { updatedStyle } from "./style-attribute"

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
  slide_identity?: string
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
  slide_identity?: string
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

  /* EDIT MODE OWNS INPUT. While editing, the page's own handlers never see a pointer,
     mouse, key, wheel, focus, touch or drag event: a deck's click zones, key bindings
     and swipe handlers can't flip a slide or keep focus in a block you clicked away
     from. One capture listener on window, registered before any other, stops each
     trusted event's propagation there and replays it to this client's own
     window/document listeners (registered through `on`, which then skip the native
     call) in the order the browser would have run them, honouring their own
     stopPropagation. Only propagation stops, so window-level capture listeners added
     after this one (a test driver's hit checks) still see it. Defaults are never
     prevented here:
     the browser still places the caret, types, and selects. Events aimed at our own
     chrome reach its controls and stop at the chrome's root (`ownChrome`).
     Synthetic events pass: the host's deck bar drives a deck with synthesized keys. */
  const OWNED = new Set(
    "pointerdown pointermove pointerup pointercancel mousedown mousemove mouseup click dblclick auxclick contextmenu keydown keypress keyup wheel focus blur focusin focusout dragstart dragover drop dragend touchstart touchmove touchend".split(
      " ",
    ),
  )
  /** Events the router already replayed to our listeners. */
  const routed = new WeakSet<Event>()
  const ownListeners: {
    t: Window | Document
    type: string
    fn: (e: Event) => void
    cap: boolean
  }[] = []
  const on = <K extends keyof DocumentEventMap>(
    t: Window | Document,
    type: K,
    fn: (e: DocumentEventMap[K]) => void,
    opts: boolean | AddEventListenerOptions = false,
  ) => {
    t.addEventListener(type, (e) => routed.has(e) || (fn as EventListener)(e), opts)
    const cap = typeof opts === "boolean" ? opts : !!opts.capture
    ownListeners.push({ t, type, fn: fn as (e: Event) => void, cap })
  }
  /** The server stamped source ids on this page (an editor opened an HTML/deck
   *  version), so saves go as exact-source ops instead of text quotes. */
  const stamped = () => document.documentElement.hasAttribute("data-derive-src-version")
  const ownsInput = (e: Event): boolean => editOn && e.isTrusted && e.target instanceof Element
  /** Run our listeners for `e` from `phase` on: 0 window capture, 1 document
   *  capture, 2 document bubble, 3 window bubble. */
  const replay = (e: Event, phase: number) => {
    let stop = 0
    const halt = (level: number) => () => {
      stop = Math.max(stop, level)
    }
    Object.defineProperty(e, "stopPropagation", { value: halt(1), configurable: true })
    Object.defineProperty(e, "stopImmediatePropagation", { value: halt(2), configurable: true })
    // A focus or blur on an element never reaches bubble listeners (those are for the
    // window's own focus).
    const last = e.bubbles ? 4 : 2
    for (; phase < last && !stop; phase++) {
      const t = phase === 1 || phase === 2 ? document : window
      for (const l of ownListeners)
        if (l.t === t && l.type === e.type && l.cap === phase < 2 && stop < 2)
          try {
            l.fn.call(t, e)
          } catch (_e) {}
    }
    delete (e as { stopPropagation?: unknown }).stopPropagation
    delete (e as { stopImmediatePropagation?: unknown }).stopImmediatePropagation
  }
  for (const type of OWNED)
    window.addEventListener(
      type,
      (e) => {
        if (!ownsInput(e) || asEl(e.target)?.closest(".derive-edit-ui")) return
        e.stopPropagation()
        routed.add(e)
        replay(e, 0)
      },
      true,
    )
  /** Our chrome's own controls hear their events; the page above them doesn't. */
  const ownChrome = (el: Element) => {
    for (const type of OWNED)
      el.addEventListener(type, (e) => {
        if (!ownsInput(e)) return
        e.stopPropagation()
        routed.add(e)
        replay(e, 2)
      })
  }

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
  on(document, "mouseup", () => setTimeout(emitSelection, 0))

  /* Touch makes "select a phrase, then find a tiny floating button" miserable, and
     iOS pops its own Copy/Look-Up menu over wherever we'd place one. So on touch we
     (a) emit drag-selections on a debounced selectionchange (they glide as you drag
     the handles, no mouseup needed) and (b) treat a clean tap on a text block as a
     coarse "comment on this" anchor. The host shows a bottom bar for both; here we
     just report. tapGuard keeps the collapse that follows a tap from clearing it. */
  let emitT = 0
  let tapGuard = 0
  // Host-controlled visual review mode. It is deliberately separate from ordinary
  // text selection: while on, a clean click/tap chooses one semantic visual target
  // and hands it to the existing durable ElementSelector comment path.
  let reviewOn = false
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
  on(
    document,
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
  on(
    document,
    "touchmove",
    (e) => {
      const t = e.touches?.[0]
      if (t && (Math.abs(t.clientX - tx) > 10 || Math.abs(t.clientY - ty) > 10)) tMoved = true
    },
    { passive: true },
  )
  on(
    document,
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
      if (reviewOn && ael) {
        tapGuard = Date.now()
        selectReviewElement(ael)
        return
      }
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
  on(document, "mousemove", (e) => {
    pX = e.clientX
    pY = e.clientY
    pIn = true
    const n = Date.now()
    if (n - cT < 40) return
    cT = n
    postCursor("cursor")
  })
  on(document, "mousedown", (e) => {
    pX = e.clientX
    pY = e.clientY
    pIn = true
    postCursor("cursor-tap")
  })
  document.addEventListener("mouseleave", () => {
    pIn = false
    post({ type: "cursor-leave" })
  })
  on(window, "blur", () => {
    pIn = false
    post({ type: "cursor-leave" })
  })
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      pIn = false
      post({ type: "cursor-leave" })
    }
  })
  /** THE gate: the editable block the caret is in, or null. Everything that
   *  silences the page reads this and nothing else. */
  const editingCaret = (): HTMLElement | null => {
    if (!editOn) return null
    const el = asEl(document.activeElement)?.closest("[data-derive-editable]")
    return el instanceof HTMLElement ? el : null
  }
  // Reassigned by edit controls mounted later in the file. Escape must dismiss a
  // focused in-frame control before it asks the host to leave the entire edit mode.
  let dismissEditUi = (): boolean => false
  // Same late-bound seam for Save: a small in-frame editor gets one chance to commit
  // its pending value before the host snapshots the document.
  let commitEditUi = (): boolean => true

  /* THE KEYBOARD. In edit mode the page hears no key at all (see OWNED): a deck's
     Space, arrows, PageUp/PageDown and Home/End can't flip a slide, with or without
     a caret in a block, and the host's deck bar still moves slides. What follows is
     only what the editor itself does with keys: its chords (the default prevented,
     since we answer them), Escape's two steps, and forwarding to the host. A throw
     in here degrades to "the shortcut did nothing" (`guard`), never to "this
     document stopped accepting text"; mid-IME keystrokes are left alone. */
  /** Run an interception so a throw inside it can never break input for the page. */
  const guard = (fn: () => void) => {
    try {
      fn()
    } catch (_e) {}
  }
  /** Our own chords, as a table: what the handler does is readable in one place,
   *  and every one of them is a modifier chord — never a bare key. */
  let cancelStructuralGesture = (): boolean => false
  const chordFor = (
    e: KeyboardEvent,
    focused: HTMLElement | null,
    precisionFocused: boolean,
  ): (() => void) | null => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return null
    const k = e.key.toLowerCase()
    // Save works with the mode open even when no block holds the caret: the host's
    // own window listener cannot see keys typed in here, and ⌘S would otherwise
    // open the browser's Save-page dialog over the document.
    if (editOn && (k === "s" || k === "enter"))
      return () => {
        if (cancelStructuralGesture()) return
        if (commitEditUi()) post({ type: "edit-save" })
      }
    // ⌘Z drives OUR stack. The native one only sees typing, and only in the block it
    // happened in — it cannot undo a bold, a link, a break, or an element resize.
    // Keep it live with no text caret because a resize grip never owns one.
    if (editOn && k === "z" && !precisionFocused)
      return () => {
        if (!cancelStructuralGesture()) (e.shiftKey ? redo : undo)()
      }
    if (!focused && editOn && blockSel && !precisionFocused && !e.shiftKey) {
      if (k === "d") return duplicateBlock
      if (k === "c" || k === "x") return () => clipBlock(k === "c")
      if (k === "v" && blockClip) return pasteBlock
    }
    if (!focused) return null
    // ⌘A selects the block being edited, never the page: typing over a document-wide
    // selection replaced one word and glued the rest of the block together.
    if (k === "a" && !e.shiftKey)
      return () => {
        const range = document.createRange()
        range.selectNodeContents(focused)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        scheduleDirty()
      }
    // ⌘B / ⌘I never fired here at all: a plaintext-only contenteditable drops every
    // format command, so these keys did nothing in a mode that looks like an editor.
    if (k === "b") return () => applyFmt("b")
    if (k === "i") return () => applyFmt("i")
    if (k === "k")
      return () => {
        // The bar asks for the URL when the BUTTON is used; from the keyboard the
        // sandbox's one available dialog is the least ceremony.
        const href = window.prompt("Link to:")?.trim()
        if (href) applyFmt("a", href)
      }
    return null
  }
  const ownKeys = (e: KeyboardEvent) =>
    guard(() => {
      const focused = editingCaret()
      const precisionFocused = !!asEl(document.activeElement)?.closest(".derive-resize-panel")
      // An IME is mid-word. Not ours to interpret.
      if (e.isComposing || e.keyCode === 229) return
      if (e.type === "keydown") {
        const run = chordFor(e, focused, precisionFocused)
        if (run) {
          e.preventDefault()
          e.stopImmediatePropagation()
          run()
          return
        }
        // The directory lives in the host (this sandboxed frame has no authenticated
        // access to it), but the caret belongs here. Keep the familiar picker keys
        // in the frame and route them across the boundary before Escape's normal
        // "leave this block" grammar gets a chance to run.
        if (
          editMention &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey &&
          (e.key === "ArrowDown" ||
            e.key === "ArrowUp" ||
            e.key === "Enter" ||
            e.key === "Tab" ||
            e.key === "Escape")
        ) {
          e.preventDefault()
          e.stopImmediatePropagation()
          post({ type: "edit-mention-key", key: e.key })
          if (e.key === "Escape") clearEditMention()
          return
        }
        if (e.key === "Escape") {
          if (cancelStructuralGesture()) {
            e.preventDefault()
            e.stopImmediatePropagation()
            return
          }
          if (reviewOn) {
            e.preventDefault()
            e.stopImmediatePropagation()
            setReviewMode(false)
            post({ type: "review-mode-ended" })
            return
          }
          if (!focused && dismissEditUi()) {
            e.preventDefault()
            e.stopImmediatePropagation()
            return
          }
          // One step out at a time: the caret gives way to the block around it,
          // a block to its parent, the last one to nothing. The typed text and the
          // session survive every step; only an Escape with nothing left asks the
          // host to leave the MODE.
          if (focused || blockSel) {
            e.stopImmediatePropagation()
            if (focused) dropCaret()
            selectBlock(focused ? blockOf(focused) : blockSel && parentBlock(blockSel))
            return
          }
          // Focus is inside the frame, where the host's listener can't see it —
          // forward it for host-level dismissals (leaving focus mode, a composer).
          post({ type: "esc" })
          return
        }
        // `p` presents, for the same reason: one click into a document moves
        // keyboard focus in here and the host goes deaf. Forwarded, not swallowed,
        // so a deck that binds `p` itself still gets it. Not while editing: there a
        // stray letter typed with no block armed must do nothing at all.
        if (e.key.toLowerCase() === "p" && !e.metaKey && !e.ctrlKey && !e.altKey && !editOn)
          post({ type: "present" })
      }
    })
  on(window, "keydown", ownKeys, true)

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
    /* Visual review mode: the document remains itself; only the eligible target
       under the pointer gets a calm, explicit invitation. */
    "body.derive-review-mode{cursor:crosshair!important}" +
    "body.derive-review-mode :is(a,button){cursor:crosshair!important}" +
    ".derive-review-hover{outline:2px solid rgba(100,116,139,.85)!important;outline-offset:4px!important;border-radius:4px}" +
    ".derive-review-flash{animation:derive-review-flash 1s ease 2}" +
    "@keyframes derive-review-flash{50%{outline:4px solid rgba(100,116,139,.72);outline-offset:6px}}" +
    /* inline edit mode: the block being edited carries a quiet ring; a block with
       unsaved changes keeps a faint tint so you can see what you touched. Same slate
       family as the comment highlights — one visual voice, nothing loud. */
    "[data-derive-editable]{cursor:text}" +
    "[data-derive-editable]:focus{outline:2px solid rgba(100,116,139,.6);outline-offset:3px;border-radius:3px}" +
    ".derive-edited{background-color:rgba(100,116,139,.08);border-radius:2px}" +
    /* A mention is still plain, portable `@handle` source. In the rendered document,
       though, it earns a compact capsule so a handoff reads as addressed rather than
       incidental prose. currentColor makes the treatment adapt to an artifact's own
       palette; the slate wash is only a fallback for browsers without color-mix. */
    ".derive-mention{display:inline-block;margin:0 .06em;padding:.06em .34em .08em;border-radius:999px;background:rgba(100,116,139,.12);box-shadow:inset 0 0 0 1px rgba(100,116,139,.24);color:inherit;font-weight:600;line-height:1.35;white-space:nowrap;text-decoration:none;vertical-align:baseline}" +
    ".derive-mention[data-derive-mention-new]{animation:derive-mention-in .18s cubic-bezier(.16,1,.3,1)}" +
    "@keyframes derive-mention-in{from{opacity:.45;transform:translateY(1px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}" +
    "@media(prefers-reduced-motion:reduce){.derive-mention[data-derive-mention-new]{animation:none}}" +
    /* The invitation. In edit mode the block under the pointer lifts slightly, so the
       document itself shows which runs are editable BEFORE you commit a click —
       without it, edit mode is pixel-identical to reading and you have to click
       something to discover what counts as text. Tracks exactly what a click would
       activate (same editContainerFor), so it can never promise the wrong region. */
    ".derive-edit-hover{background-color:rgba(100,116,139,.09);border-radius:3px;outline:1px solid rgba(100,116,139,.22);outline-offset:2px;cursor:text}" +
    /* Direct manipulation: a source-safe selection box around media and opted-in
       containers. It lives in our overlay layer, never in the target's layout. */
    ".derive-resize-box{position:absolute;display:none;pointer-events:none;box-sizing:border-box;border:1.5px solid rgba(100,116,139,.82);border-radius:3px;box-shadow:0 0 0 3px rgba(100,116,139,.12);z-index:2147483642}" +
    ".derive-resize-handle{position:absolute;right:-7px;bottom:-7px;width:14px;height:14px;padding:0;border:2px solid rgba(100,116,139,.95);border-radius:3px;background:rgb(248,250,252);box-shadow:0 1px 4px rgba(0,0,0,.28);cursor:nwse-resize;pointer-events:auto;touch-action:none}" +
    ".derive-resize-size{position:absolute;right:-1px;bottom:-27px;min-height:21px;padding:3px 7px;border:0;border-radius:4px;background:rgba(30,41,59,.94);color:#fff;font:600 11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;cursor:pointer;pointer-events:auto}" +
    /* The readout is the progressive-disclosure trigger: one quiet number at rest,
       then an exact-size form only when someone asks for it. */
    ".derive-resize-panel{position:absolute;top:calc(100% + 31px);right:-1px;display:none;width:224px;box-sizing:border-box;padding:10px;border:1px solid rgba(100,116,139,.45);border-radius:7px;background:rgb(248,250,252);color:#1e293b;box-shadow:0 8px 24px rgba(15,23,42,.22);font:500 12px/1.25 system-ui,sans-serif;pointer-events:auto}" +
    ".derive-resize-box.derive-resize-precision .derive-resize-panel{display:grid;gap:9px}" +
    ".derive-resize-box.derive-resize-panel-above .derive-resize-panel{top:auto;bottom:calc(100% + 10px)}" +
    ".derive-resize-box.derive-resize-panel-left .derive-resize-panel{right:auto;left:-1px}" +
    ".derive-resize-fields{display:grid;grid-template-columns:1fr 1fr;gap:8px}" +
    ".derive-resize-field{display:grid;gap:4px;color:#475569;font-size:11px}" +
    ".derive-resize-input{width:100%;height:30px;box-sizing:border-box;padding:4px 7px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;color:#0f172a;font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;outline:none}" +
    ".derive-resize-lock{display:flex;align-items:center;gap:7px;min-height:20px;color:#334155;cursor:pointer}" +
    ".derive-resize-lock input{width:14px;height:14px;margin:0;accent-color:#475569}" +
    ".derive-resize-lock:has(input:disabled){cursor:default;color:#64748b}" +
    ".derive-resize-actions{display:flex;align-items:center;justify-content:space-between;gap:8px}" +
    ".derive-resize-button{height:29px;padding:0 9px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;color:#334155;font:600 11px/27px system-ui,sans-serif;cursor:pointer}" +
    ".derive-resize-apply{margin-left:auto;border-color:#334155;background:#334155;color:#fff}" +
    ".derive-resize-button:disabled{opacity:.45;cursor:default}" +
    ".derive-resize-replace{position:absolute;top:6px;left:6px;height:25px;padding:0 8px;border:1px solid rgba(100,116,139,.55);border-radius:5px;background:rgba(248,250,252,.96);color:#334155;font:600 11px/23px system-ui,sans-serif;cursor:pointer;pointer-events:auto;white-space:nowrap}" +
    ".derive-resize-box:not(.derive-resize-image) .derive-resize-replace{display:none}" +
    ".derive-resize-box:not(.derive-resize-enabled) :is(.derive-resize-handle,.derive-resize-size,.derive-resize-panel){display:none}" +
    ".derive-resize-handle:focus-visible,.derive-resize-size:focus-visible,.derive-resize-replace:focus-visible,.derive-resize-button:focus-visible{outline:2px solid rgba(100,116,139,.95);outline-offset:2px}" +
    ".derive-resize-input:focus-visible{border-color:#475569;outline:2px solid rgba(100,116,139,.34);outline-offset:1px}" +
    /* Blocks: what hover names, what a click on a block's non-text area selects, and
       the pill beside it. Indigo, the one voice the editor's own chrome speaks. */
    ".derive-block-hover,.derive-block-box{position:absolute;display:none;pointer-events:none;box-sizing:border-box;border-radius:6px;z-index:2147483642}" +
    ".derive-block-hover{box-shadow:0 0 0 1px rgba(79,70,229,.55)}" +
    ".derive-block-box{box-shadow:0 0 0 2px rgba(79,70,229,.9);z-index:2147483643}" +
    ".derive-block-tag{position:absolute;left:-1px;bottom:100%;margin-bottom:2px;padding:2px 7px;border-radius:5px 5px 5px 0;background:rgba(79,70,229,.78);color:#fff;font:600 11px/1.45 system-ui,sans-serif;white-space:nowrap;cursor:grab;pointer-events:auto;user-select:none;touch-action:none}" +
    ".derive-block-tag-in .derive-block-tag{top:0;bottom:auto;margin:0;border-radius:5px 0 5px 0}" +
    ".derive-block-rz{position:absolute;display:none;padding:0;box-sizing:border-box;border:2px solid rgba(79,70,229,.95);background:#fff;box-shadow:0 1px 4px rgba(15,23,42,.25);pointer-events:auto;touch-action:none}" +
    ".derive-block-rz-e{right:-6px;top:50%;width:10px;height:28px;margin-top:-14px;border-radius:5px;cursor:ew-resize}" +
    ".derive-block-rz-se{right:-7px;bottom:-7px;width:12px;height:12px;border-radius:3px;cursor:nwse-resize}" +
    ".derive-block-box[data-resize~=width] .derive-block-rz-e,.derive-block-box[data-resize~=both] .derive-block-rz-se{display:block}" +
    ".derive-block-size{position:absolute;right:0;top:calc(100% + 8px);display:none;padding:2px 7px;border-radius:5px;background:#0f172a;color:#fff;font:600 11px/1.45 system-ui,sans-serif;white-space:nowrap}" +
    ".derive-block-box.derive-block-sizing .derive-block-size{display:block}" +
    ".derive-block-pill{position:absolute;display:none;align-items:center;gap:2px;padding:3px;border:1px solid #d9dce3;border-radius:10px;background:#fff;color:#1c1f24;box-shadow:0 6px 18px rgba(15,23,42,.16);font:500 13px/1.2 system-ui,sans-serif;white-space:nowrap;pointer-events:auto;z-index:2147483645}" +
    ".derive-block-pill button{all:unset;display:inline-flex;align-items:center;gap:5px;padding:5px 8px;border-radius:7px;cursor:pointer}" +
    ".derive-block-pill button:hover:not(:disabled){background:#f1f5f9}" +
    ".derive-block-pill button:disabled{opacity:.3;cursor:default}" +
    ".derive-block-pill button:focus-visible,.derive-block-rz:focus-visible{outline:2px solid rgba(79,70,229,.9);outline-offset:1px}" +
    ".derive-block-pill .derive-block-name{font-weight:650;cursor:grab;touch-action:none}" +
    ".derive-block-name span{color:#868e96}" +
    ".derive-block-pill .derive-block-del{color:#b91c1c}" +
    ".derive-block-div{width:1px;height:18px;margin:0 2px;background:#e9ecef}" +
    ".derive-block-dragging{opacity:.92;box-shadow:0 12px 30px rgba(15,23,42,.22)!important}" +
    ".derive-block-flash{animation:derive-block-flash .9s ease}" +
    "@keyframes derive-block-flash{0%{outline:3px solid rgba(250,204,21,.95);outline-offset:2px}100%{outline:3px solid transparent;outline-offset:2px}}" +
    /* Structural dimensions are product semantics, not a suggestion to every deck
       author to recreate the same CSS. Runtime-only legacy nodes and canonical
       authored nodes therefore render the same in a fixed stage. Row widths also
       take flex-basis authority so a common `flex:1` card rail is resizable. */
    ":is([data-derive-region],[data-derive-runtime-region]):is([data-derive-layout],[data-derive-runtime-layout])>:is([data-derive-node],[data-derive-runtime-node]):is([data-derive-size=compact],[data-derive-runtime-size=compact]){width:50%!important;max-width:none!important;box-sizing:border-box!important}" +
    ":is([data-derive-region],[data-derive-runtime-region]):is([data-derive-layout],[data-derive-runtime-layout])>:is([data-derive-node],[data-derive-runtime-node]):is([data-derive-size=standard],[data-derive-runtime-size=standard]){width:75%!important;max-width:none!important;box-sizing:border-box!important}" +
    ":is([data-derive-region],[data-derive-runtime-region]):is([data-derive-layout],[data-derive-runtime-layout])>:is([data-derive-node],[data-derive-runtime-node]):is([data-derive-size=full],[data-derive-runtime-size=full]){width:100%!important;max-width:none!important;box-sizing:border-box!important}" +
    ":is([data-derive-region],[data-derive-runtime-region]):is([data-derive-layout],[data-derive-runtime-layout])>:is([data-derive-node],[data-derive-runtime-node]):is([data-derive-width],[data-derive-runtime-width]){width:var(--derive-structural-width)!important;max-width:none!important;box-sizing:border-box!important}" +
    ":is([data-derive-region][data-derive-layout=row],[data-derive-runtime-region][data-derive-runtime-layout=row])>:is([data-derive-node],[data-derive-runtime-node]):is([data-derive-size=compact],[data-derive-runtime-size=compact]){flex:0 0 50%!important}" +
    ":is([data-derive-region][data-derive-layout=row],[data-derive-runtime-region][data-derive-runtime-layout=row])>:is([data-derive-node],[data-derive-runtime-node]):is([data-derive-size=standard],[data-derive-runtime-size=standard]){flex:0 0 75%!important}" +
    ":is([data-derive-region][data-derive-layout=row],[data-derive-runtime-region][data-derive-runtime-layout=row])>:is([data-derive-node],[data-derive-runtime-node]):is([data-derive-size=full],[data-derive-runtime-size=full]){flex:0 0 100%!important}" +
    ":is([data-derive-region][data-derive-layout=row],[data-derive-runtime-region][data-derive-runtime-layout=row])>:is([data-derive-node],[data-derive-runtime-node]):is([data-derive-width],[data-derive-runtime-width]){flex:0 0 var(--derive-structural-width)!important}" +
    ":is([data-derive-region],[data-derive-runtime-region]):is([data-derive-layout],[data-derive-runtime-layout])>:is([data-derive-node],[data-derive-runtime-node]):is([data-derive-height],[data-derive-runtime-height]){height:var(--derive-structural-height)!important;box-sizing:border-box!important}" +
    ":is([data-derive-region],[data-derive-runtime-region]):is([data-derive-layout],[data-derive-runtime-layout])>:is([data-derive-node],[data-derive-runtime-node]):is([data-derive-align],[data-derive-runtime-align]){align-self:var(--derive-structural-align)!important}" +
    ":is([data-derive-region],[data-derive-runtime-region]):is([data-derive-gap],[data-derive-runtime-gap]){gap:var(--derive-structural-gap)!important}" +
    /* ...and again derived from the block's OWN text colour, which by definition
       contrasts with whatever the artifact painted behind it. The slate wash above
       composites to ~1:1 on a dark page — invisible exactly where the invitation
       matters most. Declared second so it wins wherever color-mix is supported, and
       the rgba rule remains the fallback where it is not. */
    "@supports (color: color-mix(in srgb, currentColor 10%, transparent)){" +
    ".derive-edit-hover{background-color:color-mix(in srgb, currentColor 8%, transparent);outline-color:color-mix(in srgb, currentColor 38%, transparent)}" +
    "[data-derive-editable]:focus{outline-color:color-mix(in srgb, currentColor 70%, transparent)}" +
    ".derive-mention{background:color-mix(in srgb,currentColor 9%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,currentColor 25%,transparent)}" +
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
    let ordinal = 0
    for (let i = 0; i < list.length; i++) {
      const candidate = list[i]
      // Editor/comment overlays are appended to the artifact DOM but do not exist in
      // stored source. Leaving them in this count can shift selectors for content a
      // client-side app mounts after the overlay.
      if (candidate?.closest?.(".derive-edit-ui,.derive-el-hl")) continue
      if (candidate === el) return ordinal
      ordinal++
    }
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
    // Linked bundles author these stable targets for loop steps, policies, graph
    // nodes, and edges. Prefer the semantic wrapper over an SVG/text child — even
    // when the visual itself contains an otherwise-interactive link or button.
    const review = t.closest("[data-derive-review-id]")
    if (review) return review
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
    const reviewKind = el.getAttribute("data-derive-review-kind")
    if (
      reviewKind === "loop-step" ||
      reviewKind === "loop-policy" ||
      reviewKind === "loop-transition" ||
      reviewKind === "graph-node" ||
      reviewKind === "graph-edge"
    )
      return reviewKind
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
    const reviewLabel = normWs(el.getAttribute("data-derive-review-label") || "")
    if (reviewLabel) return reviewLabel
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

  let reviewHover: Element | null = null
  const setReviewHover = (el: Element | null) => {
    if (el === reviewHover) return
    reviewHover?.classList.remove("derive-review-hover")
    reviewHover = el
    reviewHover?.classList.add("derive-review-hover")
  }
  const setReviewMode = (on: boolean) => {
    reviewOn = on && !editOn
    document.body?.classList.toggle("derive-review-mode", reviewOn)
    if (!reviewOn) setReviewHover(null)
  }
  const selectReviewElement = (el: Element) => {
    const r = el.getBoundingClientRect()
    post({
      type: "select",
      element: true,
      reviewPicked: true,
      rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
      selector: buildElSelector(el),
    })
    setReviewMode(false)
    post({ type: "review-mode-ended" })
  }
  on(document, "mousemove", (e) => {
    if (!reviewOn) return
    setReviewHover(anchorEl(asEl(e.target)))
  })
  document.addEventListener("mouseleave", () => {
    if (reviewOn) setReviewHover(null)
  })

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
        if (el?.closest?.(".derive-el-hl,.derive-edit-ui")) return NodeFilter.FILTER_REJECT
        // Typeset math is glyph soup the server never has: the TeX rides in an
        // attribute and the source projection counts a formula as no characters.
        // Skipping it keeps quotes, context windows and edit snapshots in step.
        if (el?.closest?.("[data-derive-math]")) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      },
    })
    const out: Text[] = []
    let n: Node | null
    // biome-ignore lint/suspicious/noAssignInExpressions: standard TreeWalker iteration
    while ((n = w.nextNode())) out.push(n as Text)
    return out
  }

  /* === Rendered document @mentions ===========================================
     Mentions persist as portable, readable `@handle` source — never an app-private
     user id or a span in a saved document. This is only a presentational wrapper in
     the iframe. The grammar intentionally mirrors content-mentions.ts, including
     its email / domain boundary, so what looks addressed here is what publish will
     consider for a collaborator notification (subject to the server's access gate).

     We decorate once at document boot, then keep the small wrapper through inline
     editing. That matters for a double-click on a chip: replacing its text node on
     mode entry would invalidate the captured caret before the host has armed the
     editable block. The save serializer already reduces unknown editor spans back to
     their text, so the visual wrapper can never leak into source. */
  const mentionChip = (handle: string, fresh = false): HTMLSpanElement => {
    const chip = document.createElement("span")
    chip.className = "derive-mention"
    chip.setAttribute("data-derive-mention", "")
    if (fresh) {
      chip.setAttribute("data-derive-mention-new", "")
      window.setTimeout(() => chip.removeAttribute("data-derive-mention-new"), 220)
    }
    chip.textContent = `@${handle}`
    return chip
  }
  const canDecorateMention = (node: Text): boolean => {
    const parent = node.parentElement
    // Source code and controls are not reader prose. Aside from preserving their
    // intended styling, skipping them matches the notification parser's promise not
    // to turn examples, forms, or scripts into actual body mentions.
    return !parent?.closest(`${MENTION_NON_PROSE_SELECTOR},.derive-edit-ui`)
  }
  const mentionHandlesInDocument = (): string[] => {
    const handles = new Set<string>()
    for (const node of textNodes(document.body)) {
      if (!node.isConnected || !canDecorateMention(node)) continue
      for (const token of mentionTokens(node.nodeValue ?? ""))
        handles.add(token.handle.toLowerCase())
    }
    return [...handles].slice(0, 50)
  }
  const decorateMentions = (resolved: ReadonlySet<string>) => {
    if (!document.body) return
    for (const node of textNodes(document.body)) {
      if (!node.isConnected || !canDecorateMention(node)) continue
      const value = node.nodeValue ?? ""
      let last = 0
      let fragment: DocumentFragment | null = null
      for (const token of mentionTokens(value)) {
        if (!resolved.has(token.handle.toLowerCase())) continue
        if (!fragment) fragment = document.createDocumentFragment()
        if (token.start > last)
          fragment.appendChild(document.createTextNode(value.slice(last, token.start)))
        fragment.appendChild(mentionChip(token.handle))
        last = token.end
      }
      if (!fragment) continue
      if (last < value.length) fragment.appendChild(document.createTextNode(value.slice(last)))
      node.replaceWith(fragment)
    }
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
  /* deck slides in DOCUMENT ORDER: explicit [data-derive-slide] if the deck stamps them,
     else .slide. Empty on a non-deck artifact — then anchors resolve against the whole doc.

     Document order, NOT attribute order. `data-derive-slide` is IDENTITY — it stays with a
     slide for life so a comment thread has something stable to hold, and a reorder
     deliberately leaves it alone. A deck's own script reveals slides in DOM order, so once
     a deck can be rearranged, an attribute sort disagrees with the page about which slide
     is which: the host would drive to "slide 3" and land elsewhere, and a comment left on
     screen would pin to a different slide than the one it was made on. Sorting was only
     ever safe while nothing could reorder a deck. */
  const slideEls = (): Element[] => {
    const ex = document.querySelectorAll("[data-derive-slide]")
    if (ex.length) return Array.from(ex)
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
  let lastOutline = ""
  const postDeckOutline = () => {
    // Bound what crosses the frame boundary. A hostile page can claim a billion slides;
    // Derive still needs a responsive host even when that page's own DOM is unreasonable.
    const slides = slideEls().slice(0, 500)
    if (slides.length < 2) return
    const explicit = slides.map((slide) => {
      const value = slide.getAttribute("data-derive-slide")
      return value !== null && /^-?\d+$/.test(value) ? Number(value) : null
    })
    let nextIdentity =
      Math.max(-1, ...explicit.filter((value): value is number => value !== null)) + 1
    const outline = slides.map((slide, i) => {
      const heading = slide.querySelector("[data-slide-title],h1,h2,h3")
      const raw = (heading?.textContent || slide.textContent || "").replace(/\s+/g, " ").trim()
      return {
        // Predict the server's first-arrange stamping for class-only decks. Comments made
        // before that save then keep the same identity after slides move.
        id: slide.getAttribute("data-derive-slide") || String(nextIdentity++),
        label: raw.slice(0, 90) || `Untitled slide ${i + 1}`,
      }
    })
    const key = JSON.stringify(outline)
    if (key === lastOutline) return
    lastOutline = key
    post({ type: "deck-outline", slides: outline })
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
      postDeckOutline()
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
        postDeckOutline()
        // The slide changed under an open edit session — re-mask (see below).
        if (editOn) maskOffscreenSlides()
      })
      for (const s of slides)
        mo.observe(s, { attributes: true, attributeFilter: ["class", "style"] })
    } catch (_e) {}
  }

  /* ── HTML video scenes ──────────────────────────────────────────────────────
     A canonical video is still authored HTML. The injected client supplies the
     small common runtime: scene position, playback and host control. Authors keep
     complete control of each scene's visual design; Derive only toggles `hidden`
     and reads the four data attributes that form the editing contract. */
  const videoRoot = (): HTMLElement | null =>
    document.querySelector<HTMLElement>("[data-derive-video]")
  const videoScenes = (): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-derive-scene]"))
  let videoAt = 0
  let videoPlaying = false
  let videoStarted = 0
  let videoElapsed = 0
  let videoTimer = 0
  const videoDuration = (el: HTMLElement | undefined): number =>
    Math.max(1000, Math.min(30000, Number(el?.dataset.durationMs) || 5000))
  const videoTotalDuration = (scenes = videoScenes()): number =>
    scenes.reduce((total, scene) => total + videoDuration(scene), 0)
  const videoPosition = (scenes = videoScenes()): number =>
    scenes.slice(0, videoAt).reduce((total, scene) => total + videoDuration(scene), 0) +
    videoElapsed
  const animateVideoScene = (scene: HTMLElement) => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const transition = scene.dataset.transition || "cut"
    if (transition === "cut") return
    const duration = Math.max(100, Math.min(2000, Number(scene.dataset.transitionMs) || 300))
    const keyframes: Keyframe[] =
      transition === "slide"
        ? [
            { opacity: 0, transform: "translateX(4%)" },
            { opacity: 1, transform: "translateX(0)" },
          ]
        : transition === "dissolve"
          ? [
              { opacity: 0, filter: "blur(8px)" },
              { opacity: 1, filter: "blur(0)" },
            ]
          : [{ opacity: 0 }, { opacity: 1 }]
    scene.animate(keyframes, { duration, easing: "ease-out" })
  }
  const postVideoSniff = () => {
    const scenes = videoScenes()
    const scene = scenes[videoAt]
    if (!videoRoot() || !scene) return
    post({
      type: "video-sniff",
      i: videoAt,
      total: scenes.length,
      id: scene.dataset.deriveScene || `scene-${videoAt + 1}`,
      durationMs: videoDuration(scene),
      transition: scene.dataset.transition || "cut",
      transitionMs: Number(scene.dataset.transitionMs) || 300,
      caption: scene.dataset.deriveCaption || "",
      playing: videoPlaying,
      elapsedMs: videoElapsed,
      positionMs: videoPosition(scenes),
      totalDurationMs: videoTotalDuration(scenes),
    })
  }
  const showVideoScene = (index: number) => {
    const scenes = videoScenes()
    if (!scenes.length) return
    videoAt = Math.max(0, Math.min(scenes.length - 1, index))
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i] as HTMLElement
      scene.hidden = i !== videoAt
      scene.toggleAttribute("data-derive-video-active", i === videoAt)
      if (i === videoAt) animateVideoScene(scene)
    }
    videoElapsed = 0
    videoStarted = performance.now()
    postVideoSniff()
  }
  const activeVideoSceneId = (): string | undefined => videoScenes()[videoAt]?.dataset.deriveScene
  const restoreActiveVideoScene = (id: string | undefined) => {
    const scenes = videoScenes()
    if (!scenes.length) return
    const byId = id ? scenes.findIndex((scene) => scene.dataset.deriveScene === id) : -1
    showVideoScene(byId >= 0 ? byId : Math.min(videoAt, scenes.length - 1))
  }
  const stopVideoClock = () => {
    if (videoTimer) cancelAnimationFrame(videoTimer)
    videoTimer = 0
  }
  const tickVideo = (now: number) => {
    if (!videoPlaying) return
    videoElapsed = now - videoStarted
    const scenes = videoScenes()
    const duration = videoDuration(scenes[videoAt])
    if (videoElapsed >= duration) {
      if (videoAt < scenes.length - 1) showVideoScene(videoAt + 1)
      else {
        videoPlaying = false
        videoElapsed = duration
      }
    }
    postVideoSniff()
    if (videoPlaying) videoTimer = requestAnimationFrame(tickVideo)
  }
  const driveVideo = (action: string, n?: number, id?: string) => {
    if (action === "next") showVideoScene(videoAt + 1)
    else if (action === "prev") showVideoScene(videoAt - 1)
    else if (action === "goto") showVideoScene(Number.isInteger(n) ? (n as number) : 0)
    else if (action === "play") {
      videoPlaying = true
      videoStarted = performance.now() - videoElapsed
      stopVideoClock()
      videoTimer = requestAnimationFrame(tickVideo)
    } else if (action === "pause") {
      videoElapsed = performance.now() - videoStarted
      videoPlaying = false
      stopVideoClock()
      postVideoSniff()
    } else if (action === "restart") {
      showVideoScene(0)
      driveVideo("play")
    } else if (action === "seek" && typeof n === "number") {
      const scenes = videoScenes()
      let remaining = Math.max(0, Math.min(videoTotalDuration(scenes), n))
      let at = 0
      while (at < scenes.length - 1 && remaining >= videoDuration(scenes[at])) {
        remaining -= videoDuration(scenes[at])
        at++
      }
      showVideoScene(at)
      videoElapsed = Math.min(videoDuration(scenes[at]), remaining)
      videoStarted = performance.now() - videoElapsed
      postVideoSniff()
    } else if (action === "seek-scene" && id) {
      const scenes = videoScenes()
      const at = scenes.findIndex((scene) => scene.dataset.deriveScene === id)
      if (at < 0) return
      showVideoScene(at)
      videoElapsed = Math.max(0, Math.min(videoDuration(scenes[at]), Number(n) || 0))
      videoStarted = performance.now() - videoElapsed
      postVideoSniff()
    }
  }
  type WireSceneEdit =
    | {
        op: "scene-update"
        id: string
        duration_ms?: number
        transition?: string
        transition_ms?: number
        caption?: string
      }
    | { op: "scene-move"; id: string; direction: "previous" | "next" }
    | { op: "scene-duplicate"; id: string }
    | { op: "scene-delete"; id: string }
  interface SceneHistory {
    wire: WireSceneEdit
    undo: () => void
    redo: () => void
    activeBefore: string | undefined
    activeAfter: string | undefined
  }
  const videoSceneById = (id: string): HTMLElement | null =>
    videoScenes().find((scene) => scene.dataset.deriveScene === id) ?? null
  const applySceneFromHost = (wire: WireSceneEdit) => {
    if (!editOn) return
    const scene = videoSceneById(wire.id)
    const root = videoRoot()
    if (!scene || !root) return
    const activeId = activeVideoSceneId()
    let undoScene = () => {}
    let redoScene = () => {}
    if (wire.op === "scene-update") {
      const before = {
        duration: scene.getAttribute("data-duration-ms"),
        transition: scene.getAttribute("data-transition"),
        transitionMs: scene.getAttribute("data-transition-ms"),
        caption: scene.getAttribute("data-derive-caption"),
      }
      redoScene = () => {
        if (wire.duration_ms !== undefined)
          scene.setAttribute("data-duration-ms", String(wire.duration_ms))
        if (wire.transition !== undefined) scene.setAttribute("data-transition", wire.transition)
        if (wire.transition_ms !== undefined)
          scene.setAttribute("data-transition-ms", String(wire.transition_ms))
        if (wire.caption !== undefined) scene.setAttribute("data-derive-caption", wire.caption)
      }
      undoScene = () => {
        const restore = (name: string, value: string | null) =>
          value === null ? scene.removeAttribute(name) : scene.setAttribute(name, value)
        restore("data-duration-ms", before.duration)
        restore("data-transition", before.transition)
        restore("data-transition-ms", before.transitionMs)
        restore("data-derive-caption", before.caption)
      }
    } else if (wire.op === "scene-move") {
      const originalNext = scene.nextSibling
      redoScene = () => {
        if (wire.direction === "previous") {
          const prev = scene.previousElementSibling
          if (prev?.hasAttribute("data-derive-scene")) root.insertBefore(scene, prev)
        } else {
          const next = scene.nextElementSibling
          if (next?.hasAttribute("data-derive-scene")) root.insertBefore(next, scene)
        }
      }
      undoScene = () => root.insertBefore(scene, originalNext)
    } else if (wire.op === "scene-duplicate") {
      const copy = scene.cloneNode(true) as HTMLElement
      const used = new Set(videoScenes().map((s) => s.dataset.deriveScene))
      let n = videoScenes().length + 1
      while (used.has(`scene-${n}`)) n++
      copy.dataset.deriveScene = `scene-${n}`
      redoScene = () => scene.after(copy)
      undoScene = () => copy.remove()
    } else {
      if (videoScenes().length <= 1) return
      const originalNext = scene.nextSibling
      redoScene = () => scene.remove()
      undoScene = () => root.insertBefore(scene, originalNext)
    }
    redoScene()
    restoreActiveVideoScene(activeId)
    const entry = {
      wire,
      undo: undoScene,
      redo: redoScene,
      activeBefore: activeId,
      activeAfter: activeVideoSceneId(),
    }
    sceneEdits.push(entry)
    remember({ kind: "scene", entry, activeAfter: false })
    postDirty()
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
  /* Hit testing while editing. In a stamped (exact-source) document, what isn't in
     the source — elements a script made — and what has no words to edit — a deck's
     invisible prev/next zones, an empty button stretched over a card, a decorative
     rule — leave hit testing, so a click lands on the words beneath and the browser
     places the caret itself (Shift+click and word selection included). Structural
     nodes, resizable boxes and media stay targets. Pure CSS keyed by the stamps:
     the page's own elements are never touched. */
  const editStyle = document.createElement("style")
  const MEDIA = "img,svg,video,canvas,iframe,embed,object,picture,input,textarea,select"
  const setEditHitTesting = (on: boolean) => {
    editStyle.remove()
    if (!on) return
    // Our own boxes move as they paint; the browser must never scroll to follow them.
    editStyle.textContent = "html{overflow-anchor:none}"
    ;(document.head || document.documentElement).appendChild(editStyle)
    if (!stamped()) return
    const textless: string[] = []
    for (const el of Array.from(document.body.querySelectorAll(`[${SRC_ATTR}]`)))
      if (
        !el.textContent?.trim() &&
        !el.matches(`${MEDIA},[data-derive-node],[data-derive-resizable],[data-derive-slide]`) &&
        !el.querySelector(MEDIA)
      )
        textless.push(`[${SRC_ATTR}="${el.getAttribute(SRC_ATTR)}"]`)
    editStyle.textContent +=
      `:where(body *):not([${SRC_ATTR}],[${FMT_ATTR}],.derive-mention,.derive-edit-ui,.derive-edit-ui *,.derive-el-hl,.derive-el-hl *):not(:has([${SRC_ATTR}])){pointer-events:none!important}` +
      (textless.length ? `${textless.join(",")}{pointer-events:none!important}` : "")
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
      const identityAt = a.slide_identity
        ? slides.findIndex(
            (candidate) => candidate.getAttribute("data-derive-slide") === a.slide_identity,
          )
        : -1
      const preferredAt = identityAt >= 0 ? identityAt : a.slide
      const slide = preferredAt != null ? slides[preferredAt] : undefined
      let range: Range | null = null
      let where: number | null = null
      if (preferredAt != null && slide) {
        const span = findIn(slide, a)
        if (span) {
          range = rangeAt(slide, span.start, span.end)
          where = preferredAt
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
    postDeckOutline()
    setTimeout(() => {
      postDeckSniff()
      postDeckOutline()
    }, 400)
    if (videoRoot()) showVideoScene(videoAt)
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
  on(document, "mousemove", (e) => {
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
  on(
    document,
    "click",
    (e) => {
      // Edit mode swallows the whole click grammar: no thread focusing, no link
      // navigation — a click places a caret (editClick handles link prevention). The
      // page's own click handlers never see it (see OWNED).
      if (editOn) {
        editClick(e)
        return
      }
      if (reviewOn) {
        const target = anchorEl(asEl(e.target))
        if (target) {
          e.preventDefault()
          e.stopImmediatePropagation()
          selectReviewElement(target)
        }
        return
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
      extLink(e)
    },
    true,
  )
  /* Links never navigate the sandboxed frame itself. In-page (#)
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
    if (!a) return
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
  on(
    document,
    "auxclick",
    (e) => {
      if (editOn) {
        // Same rule as editClick: no navigation while editing. Without this a
        // middle-click would run the browser default — opening the raw sandbox
        // origin in a tab, bypassing the host's scheme allowlist entirely.
        if (asEl(e.target)?.closest("a[href]")) e.preventDefault()
        return
      }
      if (e.button === 1) {
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
     in place. On an HTML page the server stamped (see `stamped`), "edit-collect"
     answers with exact-source ops: each changed element's new children, by source
     id (source-tokens.ts). On Markdown and LaTeX every enabled block snapshots its
     text nodes against a whole-document text snapshot taken at mode entry, and each
     changed node becomes a minimal {exact, prefix, suffix, new_text} quote built
     from the PRE-EDIT text, which the server resolves against the stored source.
     Paste is flattened; Enter and formatting (HTML only) are editor spans. Media and
     opted-in boxes can also carry width/height intent. */
  interface EditTarget {
    el: HTMLElement
    origHtml: string
    origValues: string[]
    origStarts: number[]
    /** Cached origValues.join("") — the dirty compare runs per keystroke tick. */
    origConcat: string
    structSig: string
  }
  type ResizableElement = HTMLElement | SVGElement
  interface ResizeTarget {
    el: ResizableElement
    /** Exact attribute state at first touch — Discard/undo put it back byte-for-byte. */
    origStyle: string | null
    /** Captured before the live style changes, so the server resolves the base element. */
    selector: Record<string, unknown>
    /** Media persists height:auto; containers persist an explicit pixel height. */
    autoHeight: boolean
    /** Media is always constrained. A box may opt into the same direct manipulation. */
    lockRatio: boolean
    /** The rendered proportion to preserve while lockRatio is on. */
    aspect: number
  }
  let editOn = false
  let sceneEdits: SceneHistory[] = []
  // The frame is HTML even when the stored document is Markdown. Element selectors
  // are only a supported write against HTML/deck SOURCE, so the host explicitly
  // enables opening-tag operations. Image replacement remains available either way.
  let elementEditsOn = false
  let editTargets: EditTarget[] = []
  let resizeTargets: ResizeTarget[] = []
  interface ResizeFocusable {
    el: ResizableElement
    tabindex: string | null
  }
  let resizeFocusables: ResizeFocusable[] = []
  // Assigned by the resize controller below. Edit mode can only be entered after
  // this client has finished evaluating, so both are live before either runs.
  let enableResizeFocus = () => {}
  let restoreResizeFocus = () => {}
  // The pre-edit snapshot. Nodes are joined with "\n" separators (and starts offsets
  // account for them) so a prefix/suffix window crossing a node seam carries
  // whitespace there — matching the server projection, which renders a space for
  // every tag. A bare concat ("high.Set") could never context-match "high. Set".
  let editBase: { text: string; starts: Map<Text, number> } | null = null
  /** Each stamped element's children at mode entry (stamped pages only). */
  let srcSnap: SrcSnapshot | null = null
  let lastDirty = -1
  /** Everything the edit bar reads, as one comparable string — so a mode where four
   *  things can change (dirty count, undo, redo, a live selection) still posts only
   *  when something a control would show actually moved. */
  let lastState = ""

  /* -- inline body @mention picker -------------------------------------------
     The frame owns text and the live Range; the host owns the authenticated people
     directory and paints the menu above this opaque-origin iframe. Persisting a
     token range lets a click in that host-side menu replace exactly what was typed
     without guessing from the document after focus has crossed the frame boundary. */
  let editMention: { token: Range; query: string } | null = null
  const clearEditMention = () => {
    editMention = null
  }
  /** A DOM range at a textContent offset. Token matching is constrained to one
   * editable block, so textContent is the same narrow, plaintext grammar this
   * editor persists. */
  const textOffsetRange = (block: HTMLElement, start: number, end: number): Range | null => {
    const nodes: Text[] = []
    const walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) nodes.push(n as Text)
    let cursor = 0
    let startPoint: { node: Text; offset: number } | null = null
    let endPoint: { node: Text; offset: number } | null = null
    for (const node of nodes) {
      const length = node.nodeValue?.length ?? 0
      if (!startPoint && start >= cursor && start <= cursor + length)
        startPoint = { node, offset: start - cursor }
      if (!endPoint && end >= cursor && end <= cursor + length)
        endPoint = { node, offset: end - cursor }
      cursor += length
    }
    if (!startPoint || !endPoint) return null
    const range = document.createRange()
    range.setStart(startPoint.node, startPoint.offset)
    range.setEnd(endPoint.node, endPoint.offset)
    return range
  }
  const detectEditMention = () => {
    if (!editOn) return
    const selection = window.getSelection()
    if (!selection?.rangeCount || !selection.isCollapsed) {
      if (editMention) {
        clearEditMention()
        post({ type: "edit-mention-close" })
      }
      return
    }
    const caret = selection.getRangeAt(0)
    const owner =
      caret.startContainer.nodeType === 1
        ? (caret.startContainer as Element)
        : caret.startContainer.parentElement
    const block = owner?.closest("[data-derive-editable]")
    if (!(block instanceof HTMLElement)) {
      if (editMention) {
        clearEditMention()
        post({ type: "edit-mention-close" })
      }
      return
    }
    const before = document.createRange()
    before.selectNodeContents(block)
    try {
      before.setEnd(caret.startContainer, caret.startOffset)
    } catch (_e) {
      return
    }
    const text = before.toString()
    // Mirrors the live-content parser's boundary rule: an @ after a word, dot,
    // hyphen, or another @ is an email / URL / identifier, not a person mention.
    const trailing = mentionQueryAtEnd(text)
    if (!trailing) {
      if (editMention) {
        clearEditMention()
        post({ type: "edit-mention-close" })
      }
      return
    }
    const { query } = trailing
    const token = textOffsetRange(block, trailing.start, trailing.end)
    if (!token) return
    // Re-query on every changed token. The host's request token discards late
    // directory responses, so a slow `@a` cannot paint over a later `@alex`.
    if (
      editMention?.query === query &&
      editMention.token.startContainer === token.startContainer &&
      editMention.token.startOffset === token.startOffset &&
      editMention.token.endContainer === token.endContainer &&
      editMention.token.endOffset === token.endOffset
    )
      return
    editMention = { token, query }
    const rect = caret.getBoundingClientRect()
    post({
      type: "edit-mention-query",
      query,
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
    })
  }
  const insertEditMention = (handle: string) => {
    if (!isMentionHandle(handle)) return
    const mention = editMention
    if (!mention?.token.startContainer.isConnected || !mention.token.endContainer.isConnected)
      return
    const owner =
      mention.token.commonAncestorContainer.nodeType === 1
        ? (mention.token.commonAncestorContainer as Element)
        : mention.token.commonAncestorContainer.parentElement
    const block = owner?.closest("[data-derive-editable]")
    if (!(block instanceof HTMLElement)) return
    checkpoint(block)
    // Insert the same plain @handle source that notifications resolve at publish,
    // wrapped only for the live document's visual treatment. The serializer reduces
    // this unknown span back to text, so source and copied text stay portable.
    const chip = mentionChip(handle, true)
    const trailingSpace = document.createTextNode(" ")
    const replacement = document.createDocumentFragment()
    replacement.append(chip, trailingSpace)
    mention.token.deleteContents()
    mention.token.insertNode(replacement)
    const caret = document.createRange()
    caret.setStartAfter(trailingSpace)
    caret.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(caret)
    block.focus({ preventScroll: true })
    clearEditMention()
    // The initial `@` already marks this block dirty. This is still needed for a
    // host response that lands before the input event's optimistic state reaches it.
    if (lastDirty <= 0) {
      lastDirty = 1
      post({ type: "edit-state", dirty: 1 })
    }
    scheduleDirty()
  }
  // The resize controller is mounted later in the file. Keeping this tiny bridge
  // here lets the shared edit-state reporter describe the CURRENT editing context
  // without coupling text history to the overlay's implementation details.
  let hasSelectedResize = () => false

  const structSigOf = (el: Element): string => {
    const list = el.querySelectorAll("*")
    let sig = ""
    for (let i = 0; i < list.length; i++) {
      const node = list[i] as Element
      // Inside a read-only island the markup belongs to the typesetter (KaTeX fills
      // a formula after load); only the island itself is part of the block's shape.
      if (node.parentElement?.closest("[data-derive-readonly]")) continue
      sig += `${node.tagName},`
    }
    return sig
  }
  const targetFor = (el: Element): EditTarget | null => {
    for (const t of editTargets) if (t.el === el) return t
    return null
  }
  const resizeTargetFor = (el: Element): ResizeTarget | null => {
    for (const t of resizeTargets) if (t.el === el) return t
    return null
  }
  const rawStyle = (el: Element): string | null => el.getAttribute("style")
  const restoreStyle = (el: ResizableElement, value: string | null) => {
    if (value === null) el.removeAttribute("style")
    else el.setAttribute("style", value)
  }
  const concatText = (el: Element): string => {
    let out = ""
    for (const n of textNodes(el)) out += n.nodeValue
    return out
  }
  /** The session's changes (see `changes`), marking each edited text block. */
  const changeList = () => {
    // Formatting counts even when not one character changed: bolding a word is a
    // real edit, and the text-only compare called that block clean — so Save
    // stayed hidden and the work was discardable without a warning.
    for (const t of editTargets)
      t.el.classList.toggle(
        "derive-edited",
        document.contains(t.el) && (concatText(t.el) !== t.origConcat || hasFmt(t.el)),
      )
    return changes()
  }
  const countDirty = () => changeList().length
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
  interface ChildList {
    el: HTMLElement
    nodes: ChildNode[]
  }
  type HistoryEntry =
    | { kind: "html"; el: HTMLElement; html: string }
    | { kind: "style"; el: ResizableElement; style: string | null }
    | {
        kind: "structural-sizing"
        el: HTMLElement
        sizeName: string
        size: string | null
        widthName: string
        width: string | null
        heightName: string
        height: string | null
        style: string | null
      }
    /** Parents' child lists before a move, duplicate, delete, paste or revert. */
    | { kind: "children"; lists: ChildList[] }
    | { kind: "scene"; entry: SceneHistory; activeAfter: boolean }
  let undoStack: HistoryEntry[] = []
  let redoStack: HistoryEntry[] = []
  let lastBurst: { el: HTMLElement; at: number } | null = null
  // The resize overlay is mounted below; history can run before/after it without
  // knowing its DOM. Reassigned once that controller exists.
  let refreshResizeUi = () => {}
  const remember = (entry: HistoryEntry) => {
    undoStack.push(entry)
    if (undoStack.length > UNDO_LIMIT) undoStack.shift()
    // A new action forks the timeline: whatever was undone is no longer ahead of us.
    redoStack = []
  }
  const checkpoint = (el: HTMLElement) => {
    remember({ kind: "html", el, html: el.innerHTML })
  }
  const checkpointStyle = (el: ResizableElement) => {
    remember({ kind: "style", el, style: rawStyle(el) })
  }
  const structuralSizingOf = (
    el: HTMLElement,
    sizeName: string,
    widthName: string,
    heightName: string,
  ): Extract<HistoryEntry, { kind: "structural-sizing" }> => ({
    kind: "structural-sizing",
    el,
    sizeName,
    size: el.getAttribute(sizeName),
    widthName,
    width: el.getAttribute(widthName),
    heightName,
    height: el.getAttribute(heightName),
    style: rawStyle(el),
  })
  const applyStructuralSizing = (entry: Extract<HistoryEntry, { kind: "structural-sizing" }>) => {
    const set = (name: string, value: string | null) =>
      value === null ? entry.el.removeAttribute(name) : entry.el.setAttribute(name, value)
    set(entry.sizeName, entry.size)
    set(entry.widthName, entry.width)
    set(entry.heightName, entry.height)
    restoreStyle(entry.el, entry.style)
  }
  /** Put `order`'s nodes into the places those same nodes hold now, in that order.
   *  Everything between them (whitespace, a footer, a subtitle) keeps its place, so a
   *  move changes nothing else and moving back restores the page exactly. */
  const reorderInPlace = (order: readonly HTMLElement[]) => {
    const slots = [...order]
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      .map((el) => el.parentNode?.insertBefore(document.createComment(""), el))
    for (const [i, el] of order.entries()) slots[i]?.replaceWith(el)
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
    if (!entry) return
    if (entry.kind === "scene") {
      if (entry.activeAfter) {
        entry.entry.redo()
        if (!sceneEdits.includes(entry.entry)) sceneEdits.push(entry.entry)
        restoreActiveVideoScene(entry.entry.activeAfter)
      } else {
        entry.entry.undo()
        sceneEdits = sceneEdits.filter((candidate) => candidate !== entry.entry)
        restoreActiveVideoScene(entry.entry.activeBefore)
      }
      to.push({ ...entry, activeAfter: !entry.activeAfter })
    } else if (entry.kind === "children") {
      to.push({ kind: "children", lists: entry.lists.map(({ el }) => ({ el, nodes: kidsOf(el) })) })
      for (const { el, nodes } of entry.lists) setKids(el, nodes)
    } else if (!document.contains(entry.el)) return
    else if (entry.kind === "structural-sizing") {
      to.push(structuralSizingOf(entry.el, entry.sizeName, entry.widthName, entry.heightName))
      applyStructuralSizing(entry)
    } else if (entry.kind === "html") {
      to.push({ kind: "html", el: entry.el, html: entry.el.innerHTML })
      entry.el.innerHTML = entry.html
      reregister(targetFor(entry.el), entry.el)
    } else if (entry.kind === "style") {
      to.push({ kind: "style", el: entry.el, style: rawStyle(entry.el) })
      restoreStyle(entry.el, entry.style)
    }
    lastBurst = null
    refreshResizeUi()
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
  const resetEditHistory = () => {
    undoStack = []
    redoStack = []
    lastBurst = null
    pendingRange = null
    lastState = ""
  }

  const postDirty = () => {
    const list = changeList()
    const n = list.length
    const range = formattableRange()
    // Markup is only the language of an HTML page; Markdown and LaTeX write it as text.
    const canFormat = !!range && !!srcSnap
    // A double-click can select a word just before its block is armed editable.
    // selectionchange sees the pre-armed block and cannot cache it, while this
    // settled state pass can. Preserve it here too so the host may safely ask an
    // intermediate question (the link URL) without losing the words it applies to.
    if (range) pendingRange = range.cloneRange()
    const pending =
      pendingRange &&
      pendingRange.startContainer.isConnected &&
      pendingRange.endContainer.isConnected
        ? pendingRange
        : null
    const contextRange = range ?? pending
    const contextNode = contextRange?.commonAncestorContainer ?? null
    const contextEl =
      contextNode?.nodeType === 1 ? (contextNode as Element) : contextNode?.parentElement
    const focused = asEl(document.activeElement)?.closest("[data-derive-editable]") ?? null
    const textBlock = focused ?? contextEl?.closest("[data-derive-editable]") ?? null
    // Keep the contextual tools standing while a host-side intermediate control
    // (currently the Link URL field) owns focus. The cached range is still the
    // command target, so swapping Inspect back to its empty state would be both
    // visually jarring and misleading.
    const textActive = !hasSelectedResize() && !!textBlock
    const textKind = textActive
      ? ({
          P: "Paragraph",
          LI: "List item",
          BLOCKQUOTE: "Quote",
          FIGCAPTION: "Caption",
          PRE: "Code block",
          TD: "Table cell",
          TH: "Table heading",
          H1: "Heading 1",
          H2: "Heading 2",
          H3: "Heading 3",
          H4: "Heading 4",
          H5: "Heading 5",
          H6: "Heading 6",
        }[textBlock?.tagName ?? ""] ?? "Text")
      : ""
    const selectedText = contextRange
      ? contextRange.toString().replace(/\s+/g, " ").trim().slice(0, 120)
      : ""
    const slides = slideEls()
    const changed = list.map(({ id, where, what, from, to, at }) => ({
      id,
      where,
      what,
      from,
      to,
      slide: at && slides.length > 1 ? slideOfEl(at, slides) : null,
    }))
    const block = blockInfo()
    const state = `${n}|${undoStack.length > 0}|${redoStack.length > 0}|${canFormat}|${textActive}|${textKind}|${selectedText}|${JSON.stringify([changed, block])}`
    if (state !== lastState) {
      lastState = state
      lastDirty = n
      post({
        type: "edit-state",
        dirty: n,
        canUndo: undoStack.length > 0,
        canRedo: redoStack.length > 0,
        canFormat,
        textActive,
        textKind,
        selectedText,
        changes: changed,
        block,
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

  /* ── Element resize ──────────────────────────────────────────────────────────
     A bounding box + one southeast grip, following the same small interaction as
     image editors everywhere. Images/media keep their natural aspect ratio; a
     `[data-derive-resizable]` container (plus common card/box naming) carries both
     dimensions. The live DOM is only the preview. Save sends an ElementSelector +
     dimensions, and the server changes that one opening tag in the stored source. */
  const DIRECT_RESIZABLE = "img,video,canvas,svg,figure,iframe,embed,object,[data-derive-resizable]"
  const BOX_HINT = /(^|[\s_-])(card|box|panel|tile|frame|visual|chart|graph|plot)([\s_-]|$)/i
  const isResizableElement = (el: Element | null): el is ResizableElement =>
    !!el && (el instanceof HTMLElement || el instanceof SVGElement)
  const resizableAt = (target: EventTarget | null): ResizableElement | null => {
    const el = asEl(target)
    if (!el?.closest || el.closest(".derive-edit-ui")) return null
    // A structural node uses authored semantic presets. Offering the generic pixel
    // grip at the same time creates two conflicting size models on one element.
    if (el.closest("[data-derive-node],[data-derive-runtime-node]")) return null
    // A Markdown image still gets the selection box's explicit Replace action, but
    // no resize controls: element operations are not defined for Markdown source.
    if (!elementEditsOn) {
      const image = el.closest("img")
      return image instanceof HTMLImageElement ? image : null
    }
    const direct = el.closest(DIRECT_RESIZABLE)
    if (isResizableElement(direct) && !direct.hasAttribute("data-derive-slide")) return direct
    const box = el.closest("div,section,article,aside")
    // A block is picked up and moved; its size, where it has one, lives on its handles.
    if (!isResizableElement(box) || box.hasAttribute("data-derive-slide") || isMovable(box, true))
      return null
    const hint = `${box.id || ""} ${box.className || ""}`
    const style = box.getAttribute("style") || ""
    return BOX_HINT.test(hint) || /\b(?:width|height)\s*:/i.test(style) ? box : null
  }
  const keepsRatio = (el: Element): boolean => /^(img|video|canvas|svg)$/i.test(el.tagName)

  /* Resize is direct manipulation, but it must not be pointer-only. During edit
   * mode, supported elements join the document's tab order without changing the
   * stored source. Focus selects the same overlay as hover/click, and Enter opens
   * exact sizing. Every authored tabindex is restored byte-for-byte. */
  enableResizeFocus = () => {
    restoreResizeFocus()
    if (!elementEditsOn) return
    const candidates = document.querySelectorAll(`${DIRECT_RESIZABLE},div,section,article,aside`)
    const seen = new Set<Element>()
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i] as Element
      const target = resizableAt(el)
      if (target !== el || seen.has(el)) continue
      seen.add(el)
      resizeFocusables.push({ el: target, tabindex: target.getAttribute("tabindex") })
      if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "0")
    }
  }
  restoreResizeFocus = () => {
    for (const target of resizeFocusables) {
      if (!document.contains(target.el)) continue
      if (target.tabindex === null) target.el.removeAttribute("tabindex")
      else target.el.setAttribute("tabindex", target.tabindex)
    }
    resizeFocusables = []
  }

  const resizeBox = document.createElement("div")
  resizeBox.className = "derive-edit-ui derive-resize-box"
  const resizeReplace = document.createElement("button")
  resizeReplace.type = "button"
  resizeReplace.className = "derive-resize-replace"
  resizeReplace.textContent = "Replace"
  resizeReplace.setAttribute("aria-label", "Replace image")
  const resizeSize = document.createElement("button")
  resizeSize.type = "button"
  resizeSize.className = "derive-resize-size"
  resizeSize.setAttribute("aria-label", "Set element size")
  const resizeHandle = document.createElement("button")
  resizeHandle.type = "button"
  resizeHandle.className = "derive-resize-handle"
  resizeHandle.setAttribute("aria-label", "Resize element")
  resizeHandle.title = "Drag or use arrow keys to resize"

  const resizePanel = document.createElement("form")
  resizePanel.className = "derive-resize-panel"
  resizePanel.setAttribute("aria-label", "Element size")
  resizePanel.noValidate = true
  const resizeFields = document.createElement("div")
  resizeFields.className = "derive-resize-fields"
  const precisionInput = (name: "Width" | "Height") => {
    const label = document.createElement("label")
    label.className = "derive-resize-field"
    label.append(name)
    const input = document.createElement("input")
    input.className = "derive-resize-input"
    input.type = "number"
    input.name = name.toLowerCase()
    input.min = "24"
    input.max = "8192"
    input.step = "1"
    input.required = true
    input.inputMode = "numeric"
    input.setAttribute("aria-label", `${name} in pixels`)
    label.append(input)
    resizeFields.append(label)
    return input
  }
  const resizeWidth = precisionInput("Width")
  const resizeHeight = precisionInput("Height")
  const resizeLockLabel = document.createElement("label")
  resizeLockLabel.className = "derive-resize-lock"
  const resizeLock = document.createElement("input")
  resizeLock.type = "checkbox"
  const resizeLockText = document.createElement("span")
  resizeLockLabel.append(resizeLock, resizeLockText)
  const resizeActions = document.createElement("div")
  resizeActions.className = "derive-resize-actions"
  const resizeReset = document.createElement("button")
  resizeReset.type = "button"
  resizeReset.className = "derive-resize-button"
  resizeReset.textContent = "Reset"
  resizeReset.setAttribute("aria-label", "Reset to authored size")
  const resizeApply = document.createElement("button")
  resizeApply.type = "submit"
  resizeApply.className = "derive-resize-button derive-resize-apply"
  resizeApply.textContent = "Apply"
  resizeActions.append(resizeReset, resizeApply)
  resizePanel.append(resizeFields, resizeLockLabel, resizeActions)
  resizeBox.append(resizeReplace, resizeSize, resizeHandle, resizePanel)
  ;(document.body || document.documentElement).appendChild(resizeBox)
  ownChrome(resizeBox)

  let resizeHoverEl: ResizableElement | null = null
  let resizeSelectedEl: ResizableElement | null = null
  hasSelectedResize = () => !!resizeSelectedEl
  let precisionOn = false
  let precisionAxis: "width" | "height" = "width"
  interface ResizeDrag {
    el: ResizableElement
    pointerId: number
    startX: number
    startY: number
    startWidth: number
    startHeight: number
    autoHeight: boolean
    lockRatio: boolean
    aspect: number
    moved: boolean
  }
  let resizeDrag: ResizeDrag | null = null

  const closePrecision = (focusTrigger: boolean) => {
    if (!precisionOn) return
    precisionOn = false
    resizeBox.classList.remove("derive-resize-precision")
    resizeWidth.setCustomValidity("")
    resizeHeight.setCustomValidity("")
    if (focusTrigger && resizeSize.offsetParent) resizeSize.focus()
  }
  dismissEditUi = () => {
    if (!precisionOn) return false
    closePrecision(true)
    return true
  }
  const resizeUiEl = (): ResizableElement | null => resizeSelectedEl ?? resizeHoverEl
  const aspectOf = (rect: DOMRect): number => {
    const aspect = rect.height > 0 ? rect.width / rect.height : 1
    return Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  }
  const clampSize = (value: number): number => Math.min(8192, Math.max(24, Math.round(value)))
  const ensureResizeTarget = (el: ResizableElement): ResizeTarget => {
    const existing = resizeTargetFor(el)
    if (existing) return existing
    const rect = el.getBoundingClientRect()
    const autoHeight = keepsRatio(el)
    const target: ResizeTarget = {
      el,
      origStyle: rawStyle(el),
      selector: buildElSelector(el),
      autoHeight,
      lockRatio: autoHeight,
      aspect: aspectOf(rect),
    }
    resizeTargets.push(target)
    return target
  }
  const paintResizeUi = () => {
    const el = resizeUiEl()
    if (!editOn || !el || !document.contains(el)) {
      closePrecision(false)
      resizeBox.style.display = "none"
      return
    }
    const r = el.getBoundingClientRect()
    if (!(r.width || r.height)) {
      closePrecision(false)
      resizeBox.style.display = "none"
      return
    }
    resizeBox.style.display = "block"
    resizeBox.style.left = `${r.left + (window.scrollX || 0)}px`
    resizeBox.style.top = `${r.top + scrollTop()}px`
    resizeBox.style.width = `${r.width}px`
    resizeBox.style.height = `${r.height}px`
    resizeBox.classList.toggle("derive-resize-image", el.tagName.toLowerCase() === "img")
    resizeBox.classList.toggle("derive-resize-enabled", elementEditsOn)
    resizeBox.classList.toggle(
      "derive-resize-panel-above",
      r.bottom + 160 > (window.innerHeight || document.documentElement.clientHeight),
    )
    resizeBox.classList.toggle("derive-resize-panel-left", r.right < 232)
    resizeSize.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`
  }
  refreshResizeUi = paintResizeUi
  const setResizeHover = (el: ResizableElement | null) => {
    if (precisionOn || resizeDrag || el === resizeHoverEl) return
    resizeHoverEl = el
    paintResizeUi()
  }
  const selectResize = (el: ResizableElement | null) => {
    if (el !== resizeSelectedEl) closePrecision(false)
    resizeSelectedEl = el
    if (el) resizeHoverEl = el
    setEditHover(null)
    paintResizeUi()
    scheduleDirty()
  }
  const clearResizeUi = () => {
    closePrecision(false)
    resizeHoverEl = null
    resizeSelectedEl = null
    resizeDrag = null
    resizeBox.style.display = "none"
  }

  const openPrecision = () => {
    const el = resizeUiEl()
    if (!elementEditsOn || !el || !document.contains(el)) return
    selectResize(el)
    const target = ensureResizeTarget(el)
    const rect = el.getBoundingClientRect()
    target.aspect = aspectOf(rect)
    resizeWidth.value = String(Math.round(rect.width))
    resizeHeight.value = String(Math.round(rect.height))
    resizeLock.checked = target.lockRatio
    resizeLock.disabled = target.autoHeight
    resizeLockText.textContent = target.autoHeight ? "Proportions locked" : "Lock proportions"
    resizeReset.disabled = rawStyle(el) === target.origStyle
    precisionAxis = "width"
    precisionOn = true
    resizeBox.classList.add("derive-resize-precision")
    paintResizeUi()
    requestAnimationFrame(() => {
      if (!precisionOn) return
      resizeWidth.focus()
      resizeWidth.select()
    })
  }
  on(document, "focusin", (e) => {
    if (!editOn || !elementEditsOn) return
    const active = asEl(e.target)
    const target = resizableAt(active)
    if (active && target === active) selectResize(target)
  })
  on(
    document,
    "keydown",
    (e) => {
      if (!editOn || !elementEditsOn || e.defaultPrevented || e.isComposing) return
      if (e.key !== "Enter" || e.metaKey || e.ctrlKey || e.altKey) return
      const active = asEl(document.activeElement)
      const target = resizableAt(active)
      if (!active || target !== active) return
      e.preventDefault()
      e.stopImmediatePropagation()
      selectResize(target)
      openPrecision()
    },
    true,
  )
  const precisionValue = (input: HTMLInputElement): number | null => {
    input.setCustomValidity("")
    const value = input.valueAsNumber
    if (!Number.isInteger(value) || value < 24 || value > 8192) {
      input.setCustomValidity("Use a whole number from 24 to 8192 pixels.")
      input.reportValidity()
      return null
    }
    return value
  }
  const syncPrecisionRatio = (axis: "width" | "height") => {
    precisionAxis = axis
    resizeWidth.setCustomValidity("")
    resizeHeight.setCustomValidity("")
    if (!resizeLock.checked) return
    const el = resizeUiEl()
    const target = el ? resizeTargetFor(el) : null
    if (!target) return
    const value = axis === "width" ? resizeWidth.valueAsNumber : resizeHeight.valueAsNumber
    if (!Number.isFinite(value) || value <= 0) return
    if (axis === "width") resizeHeight.value = String(clampSize(value / target.aspect))
    else resizeWidth.value = String(clampSize(value * target.aspect))
  }
  resizeWidth.addEventListener("input", () => syncPrecisionRatio("width"))
  resizeHeight.addEventListener("input", () => syncPrecisionRatio("height"))
  resizeLock.addEventListener("change", () => {
    const el = resizeUiEl()
    const target = el ? resizeTargetFor(el) : null
    if (!target || target.autoHeight) return
    if (!resizeLock.checked) return
    const width = resizeWidth.valueAsNumber
    const height = resizeHeight.valueAsNumber
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)
      target.aspect = width / height
    syncPrecisionRatio(precisionAxis)
  })
  resizePanel.addEventListener("submit", (e) => {
    e.preventDefault()
    e.stopPropagation()
    const el = resizeUiEl()
    const target = el ? resizeTargetFor(el) : null
    if (!el || !target || !document.contains(el)) return
    const rawWidth = precisionValue(resizeWidth)
    if (rawWidth === null) return
    const rawHeight = precisionValue(resizeHeight)
    if (rawHeight === null) return
    let width = rawWidth
    let height = rawHeight
    target.lockRatio = target.autoHeight || resizeLock.checked
    if (target.lockRatio) {
      if (precisionAxis === "height") width = clampSize(height * target.aspect)
      else height = clampSize(width / target.aspect)
      resizeWidth.value = String(width)
      resizeHeight.value = String(height)
    }
    const before = rawStyle(el)
    checkpointStyle(el)
    el.style.width = `${width}px`
    el.style.height = target.autoHeight ? "auto" : `${height}px`
    if (rawStyle(el) === before) undoStack.pop()
    else target.aspect = width / height
    closePrecision(true)
    paintResizeUi()
    postDirty()
  })
  commitEditUi = () => {
    if (!precisionOn) return true
    resizePanel.requestSubmit()
    return !precisionOn
  }
  resizeReset.addEventListener("click", (e) => {
    e.preventDefault()
    e.stopPropagation()
    const el = resizeUiEl()
    const target = el ? resizeTargetFor(el) : null
    if (!el || !target || !document.contains(el)) return
    if (rawStyle(el) !== target.origStyle) {
      checkpointStyle(el)
      restoreStyle(el, target.origStyle)
      target.lockRatio = target.autoHeight
      target.aspect = aspectOf(el.getBoundingClientRect())
    }
    closePrecision(true)
    paintResizeUi()
    postDirty()
  })
  resizeSize.addEventListener("pointerdown", (e) => e.stopPropagation())
  resizeSize.addEventListener("click", (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (precisionOn) closePrecision(true)
    else openPrecision()
  })
  resizePanel.addEventListener("pointerdown", (e) => e.stopPropagation())
  for (const type of ["keydown", "keypress", "keyup"])
    resizePanel.addEventListener(type, (e) => e.stopPropagation())
  on(
    document,
    "pointerdown",
    (e) => {
      if (!precisionOn) return
      const target = asEl(e.target)
      if (target?.closest(".derive-resize-panel,.derive-resize-size")) return
      closePrecision(false)
    },
    true,
  )

  resizeReplace.addEventListener("pointerdown", (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  resizeReplace.addEventListener("click", (e) => {
    e.preventDefault()
    e.stopPropagation()
    const el = resizeUiEl()
    if (!(el instanceof HTMLImageElement)) return
    const src = el.getAttribute("src") || ""
    if (!src || src.slice(0, 5).toLowerCase() === "data:")
      post({ type: "edit-blocked", reason: "embedded-image" })
    else post({ type: "edit-image", src, alt: el.getAttribute("alt") || "" })
  })

  resizeHandle.addEventListener("pointerdown", (e) => {
    if (!elementEditsOn) return
    const el = resizeUiEl()
    if (!el || !document.contains(el)) return
    e.preventDefault()
    e.stopPropagation()
    const target = ensureResizeTarget(el)
    checkpointStyle(el)
    const r = el.getBoundingClientRect()
    target.aspect = aspectOf(r)
    resizeSelectedEl = el
    resizeDrag = {
      el,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startWidth: r.width,
      startHeight: r.height,
      autoHeight: target.autoHeight,
      lockRatio: target.lockRatio,
      aspect: target.aspect,
      moved: false,
    }
    resizeHandle.setPointerCapture?.(e.pointerId)
  })
  resizeHandle.addEventListener("keydown", (e) => {
    if (!elementEditsOn) return
    if (!/^Arrow(?:Left|Right|Up|Down)$/.test(e.key)) return
    const el = resizeUiEl()
    if (!el || !document.contains(el)) return
    e.preventDefault()
    e.stopPropagation()
    const target = ensureResizeTarget(el)
    const before = rawStyle(el)
    checkpointStyle(el)
    const r = el.getBoundingClientRect()
    target.aspect = aspectOf(r)
    const step = e.shiftKey ? 1 : 8
    const grow = e.key === "ArrowRight" || e.key === "ArrowDown" ? step : -step
    let width = Math.round(r.width)
    let height = Math.round(r.height)
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      width = clampSize(width + grow)
      if (target.lockRatio) height = clampSize(width / target.aspect)
      el.style.width = `${width}px`
    } else {
      height = clampSize(height + grow)
      if (target.lockRatio) {
        width = clampSize(height * target.aspect)
        el.style.width = `${width}px`
      }
    }
    if (target.autoHeight) el.style.height = "auto"
    else if (target.lockRatio || e.key === "ArrowUp" || e.key === "ArrowDown")
      el.style.height = `${height}px`
    if (rawStyle(el) === before) undoStack.pop()
    paintResizeUi()
    postDirty()
  })

  on(
    window,
    "pointermove",
    (e) => {
      const drag = resizeDrag
      if (!drag || e.pointerId !== drag.pointerId) return
      e.preventDefault()
      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      if (!drag.moved && Math.abs(dx) < 1 && Math.abs(dy) < 1) return
      drag.moved = true
      const width = clampSize(drag.startWidth + dx)
      drag.el.style.width = `${width}px`
      drag.el.style.height = drag.autoHeight
        ? "auto"
        : `${drag.lockRatio ? clampSize(width / drag.aspect) : clampSize(drag.startHeight + dy)}px`
      // Arm the unsaved-work guard on the first movement, before the settled count.
      if (lastDirty <= 0) {
        lastDirty = 1
        // This optimistic state is intentionally partial. Invalidate the full-state
        // dedupe key so an immediate cancel/Undo can restore Redo even when that
        // full state happens to match one posted earlier in the session.
        lastState = ""
        post({ type: "edit-state", dirty: 1, canUndo: true })
      }
      paintResizeUi()
    },
    { passive: false },
  )

  const finishResize = (e: PointerEvent, cancel: boolean) => {
    const drag = resizeDrag
    if (!drag || e.pointerId !== drag.pointerId) return
    resizeDrag = null
    if (cancel || !drag.moved) {
      const checkpoint = undoStack.pop()
      if (checkpoint?.kind === "style" && checkpoint.el === drag.el)
        restoreStyle(drag.el, checkpoint.style)
    }
    paintResizeUi()
    postDirty()
  }
  on(window, "pointerup", (e) => finishResize(e, false))
  on(window, "pointercancel", (e) => finishResize(e, true))
  window.addEventListener("scroll", paintResizeUi, true)
  window.addEventListener("resize", paintResizeUi)

  /* ── Blocks ──────────────────────────────────────────────────────────────────
     What a person can pick up: an author's declared structural node, or any element
     that repeats (two or more look-alike siblings in the source: same tag, same
     classes), such as cards, list items, columns and table rows. Hover shows its
     name; a click on its non-text area (or on the name tag) selects it; a pill just
     outside it moves, duplicates and deletes it. A move only reorders it among those
     siblings, so a save writes the parent's new child order by source id (a
     `content` op keeping each child) and needs no author markup. Stamped pages only:
     a save writes what the page shows, by source id. */
  type StructureLayout = "stack" | "row"
  const STRUCTURE_LAYOUTS = new Set<StructureLayout>(["stack", "row"])
  const STRUCTURE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/
  const STRUCTURE_SIZES = new Set(["compact", "standard", "full"])
  type StructurePrefix = "data-derive" | "data-derive-runtime"
  const structureAttribute = (prefix: StructurePrefix, name: string) => `${prefix}-${name}`
  const structureNodeSelector = "[data-derive-node],[data-derive-runtime-node]"
  const structureRegionSelector = "[data-derive-region],[data-derive-runtime-region]"
  interface StructureNode {
    el: HTMLElement
    id: string
    kind: string
    prefix: StructurePrefix
    origSize: string | null
    origWidth: string | null
    origHeight: string | null
    origStyle: string | null
  }
  interface StructureRegion {
    el: HTMLElement
    prefix: StructurePrefix
    layout: StructureLayout
    nodes: StructureNode[]
    /** The owning node when it is itself arrangeable; null for a top-level region. */
    owner: StructureNode | null
  }
  let structureRegions: StructureRegion[] = []
  let structureRegionByNode = new Map<StructureNode, StructureRegion>()
  let structureNodeByElement = new Map<HTMLElement, StructureNode>()

  const sourceChildren = (region: HTMLElement): HTMLElement[] =>
    Array.from(region.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && !child.classList.contains("derive-edit-ui"),
    )
  const setStructureRegions = (regions: StructureRegion[]) => {
    structureRegions = regions
    structureRegionByNode = new Map(
      regions.flatMap((region) => region.nodes.map((node) => [node, region] as const)),
    )
    structureNodeByElement = new Map(
      regions.flatMap((region) => region.nodes.map((node) => [node.el, node] as const)),
    )
  }
  const regionForStructureNode = (node: StructureNode): StructureRegion | null =>
    structureRegionByNode.get(node) ?? null
  const parentStructureNode = (node: StructureNode): StructureNode | null =>
    regionForStructureNode(node)?.owner ?? null
  const connectedStructureNodes = (region: StructureRegion): StructureNode[] => {
    const byEl = new Map(region.nodes.map((node) => [node.el, node]))
    return sourceChildren(region.el)
      .map((el) => byEl.get(el))
      .filter((node): node is StructureNode => !!node)
  }
  /** The authored node this element is, when it sits directly in its region. */
  const nodeOf = (el: Element | null): StructureNode | null => {
    const node = el instanceof HTMLElement ? structureNodeByElement.get(el) : undefined
    return node && el?.parentElement === regionForStructureNode(node)?.el ? node : null
  }
  const filterOpacity = (filter: string): number => {
    let opacity = 1
    for (const match of filter.matchAll(/opacity\(\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))(%?)\s*\)/gi)) {
      const value = Number.parseFloat(match[1] || "")
      if (Number.isFinite(value)) opacity *= match[2] === "%" ? value / 100 : value
    }
    return opacity
  }
  /** On the slide on screen, painted, and not hidden by anything above it. */
  const availableEl = (el: Element): boolean => {
    if (!el.isConnected) return false
    const slides = slideEls()
    if (slides.length > 1) {
      const at = slideOfEl(el, slides)
      if (at !== null && at !== activeSlide(slides)) return false
    }
    for (let current: Element | null = el; current; current = current.parentElement) {
      const style = getComputedStyle(current)
      if (
        current.getAttribute("aria-hidden")?.trim().toLowerCase() === "true" ||
        current.hasAttribute("inert") ||
        style.display === "none" ||
        (current === el && style.display === "contents") ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number.parseFloat(style.opacity || "1") <= 0.001 ||
        filterOpacity(style.filter || "none") <= 0.001 ||
        style.contentVisibility === "hidden" ||
        (style.clipPath && style.clipPath !== "none")
      )
        return false
    }
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < innerWidth
  }
  const axisAlignedTransform = (style: CSSStyleDeclaration): boolean => {
    const rotate = style.getPropertyValue("rotate").trim()
    if (rotate && rotate !== "none" && rotate !== "0deg") return false
    if (!style.transform || style.transform === "none") return true
    try {
      const matrix = new DOMMatrixReadOnly(style.transform)
      return Math.abs(matrix.b) < 0.0001 && Math.abs(matrix.c) < 0.0001
    } catch (_e) {
      return false
    }
  }
  const structureTransformResizable = (node: StructureNode): boolean => {
    const own = getComputedStyle(node.el)
    const ownScale = own.getPropertyValue("scale").trim()
    if (
      own.transform !== "none" ||
      (ownScale && ownScale !== "none" && ownScale !== "1") ||
      !axisAlignedTransform(own)
    )
      return false
    for (let current = node.el.parentElement; current; current = current.parentElement)
      if (!axisAlignedTransform(getComputedStyle(current))) return false
    return true
  }
  /* Each region stands alone: one that breaks the contract offers no resize, and the
     rest stay sizable. Its nodes remain blocks either way. */
  const scanStructureRegions = (): StructureRegion[] => {
    const regions: StructureRegion[] = []
    const owners = new Map<StructureRegion, HTMLElement | null>()
    for (const regionEl of Array.from(document.querySelectorAll(structureRegionSelector))) {
      if (!(regionEl instanceof HTMLElement)) continue
      const hasCanonical = regionEl.hasAttribute("data-derive-region")
      const hasRuntime = regionEl.hasAttribute("data-derive-runtime-region")
      const prefix: StructurePrefix = hasRuntime ? "data-derive-runtime" : "data-derive"
      const layout = regionEl.getAttribute(structureAttribute(prefix, "layout"))
      const id = regionEl.getAttribute(structureAttribute(prefix, "region")) || ""
      if (
        hasCanonical === hasRuntime ||
        !STRUCTURE_LAYOUTS.has(layout as StructureLayout) ||
        !STRUCTURE_ID.test(id)
      )
        continue
      const gap = regionEl.getAttribute(structureAttribute(prefix, "gap"))
      const customGap = regionEl.style.getPropertyValue(STRUCTURAL_GAP_PROPERTY).trim()
      if ((gap !== null && customGap !== `${gap}px`) || (gap === null && !!customGap)) continue
      const nodeName = structureAttribute(prefix, "node")
      const children = sourceChildren(regionEl)
      // Authored and generated nodes never mix in one region.
      if (
        children.some(
          (child) => child.matches(structureNodeSelector) && !child.hasAttribute(nodeName),
        )
      )
        continue
      const nodes: StructureNode[] = []
      let valid = true
      for (const child of children.filter((c) => c.hasAttribute(nodeName))) {
        const attr = (name: string) => child.getAttribute(structureAttribute(prefix, name))
        const custom = (property: string) => child.style.getPropertyValue(property).trim()
        const size = attr("size")
        const width = attr("width")
        const height = attr("height")
        const align = attr("align")
        if (
          !STRUCTURE_ID.test(attr("node") || "") ||
          child.matches(structureRegionSelector) ||
          (size !== null && !STRUCTURE_SIZES.has(size)) ||
          (size !== null && width !== null) ||
          (width !== null &&
            (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(width) ||
              Number.parseInt(width, 10) < MIN_STRUCTURAL_WIDTH_PCT ||
              custom(STRUCTURAL_WIDTH_PROPERTY) !== `${width}%`)) ||
          (width === null && !!custom(STRUCTURAL_WIDTH_PROPERTY)) ||
          (height !== null &&
            (!/^\d+$/.test(height) ||
              Number.parseInt(height, 10) < MIN_STRUCTURAL_HEIGHT_PX ||
              Number.parseInt(height, 10) > MAX_STRUCTURAL_HEIGHT_PX ||
              custom(STRUCTURAL_HEIGHT_PROPERTY) !== `${height}px`)) ||
          (height === null && !!custom(STRUCTURAL_HEIGHT_PROPERTY)) ||
          (align !== null && custom(STRUCTURAL_ALIGN_PROPERTY) !== align) ||
          (align === null && !!custom(STRUCTURAL_ALIGN_PROPERTY))
        ) {
          valid = false
          break
        }
        nodes.push({
          el: child,
          id: attr("node") || "",
          kind: attr("kind") || "",
          prefix,
          origSize: size,
          origWidth: width,
          origHeight: height,
          origStyle: rawStyle(child),
        })
      }
      if (!valid) continue
      // A region nested in a node declares that node as its owner.
      const ownerEl = regionEl.parentElement?.closest(structureNodeSelector)
      const ownerId = ownerEl
        ? (ownerEl.getAttribute("data-derive-node") ??
          ownerEl.getAttribute("data-derive-runtime-node"))
        : null
      if (regionEl.getAttribute(structureAttribute(prefix, "owner")) !== ownerId) continue
      const region = { el: regionEl, prefix, layout: layout as StructureLayout, nodes, owner: null }
      owners.set(region, ownerEl instanceof HTMLElement ? ownerEl : null)
      regions.push(region)
    }
    const nodeByEl = new Map(
      regions.flatMap((region) => region.nodes.map((node) => [node.el, node] as const)),
    )
    for (const [region, ownerEl] of owners)
      region.owner = ownerEl ? (nodeByEl.get(ownerEl) ?? null) : null
    return regions
  }

  const structureContentWidth = (region: StructureRegion): number => {
    const style = getComputedStyle(region.el)
    return (
      region.el.clientWidth -
      (Number.parseFloat(style.paddingLeft) || 0) -
      (Number.parseFloat(style.paddingRight) || 0)
    )
  }
  const horizontalStructureWritingMode = (node: StructureNode, region: StructureRegion): boolean =>
    getComputedStyle(node.el).writingMode === "horizontal-tb" &&
    getComputedStyle(region.el).writingMode === "horizontal-tb"
  const cssTrackCount = (value: string): number => {
    let count = 0
    let depth = 0
    let inTrack = false
    for (const character of value.trim()) {
      if (character === "(") depth++
      if (character === ")") depth = Math.max(0, depth - 1)
      if (/\s/.test(character) && depth === 0) inTrack = false
      else if (!inTrack) {
        count++
        inTrack = true
      }
    }
    return count
  }
  const structureGridHasSingleColumn = (style: CSSStyleDeclaration): boolean =>
    !style.gridAutoFlow.includes("column") &&
    (style.gridTemplateColumns === "none" || cssTrackCount(style.gridTemplateColumns) === 1)
  const inFlow = (style: CSSStyleDeclaration) =>
    /^(?:static|relative)$/.test(style.position) && style.float === "none"
  const structureStackLayoutResizable = (node: StructureNode, region: StructureRegion): boolean => {
    if (region.layout !== "stack" || !horizontalStructureWritingMode(node, region)) return false
    const regionStyle = getComputedStyle(region.el)
    if (!/^(?:auto|1)$/.test(regionStyle.columnCount) || regionStyle.columnWidth !== "auto")
      return false
    if (
      regionStyle.display.includes("flex") &&
      (regionStyle.flexDirection !== "column" || regionStyle.flexWrap !== "nowrap")
    )
      return false
    if (regionStyle.display.includes("grid") && !structureGridHasSingleColumn(regionStyle))
      return false
    let previousBottom = Number.NEGATIVE_INFINITY
    for (const child of connectedStructureNodes(region)) {
      if (!availableEl(child.el)) continue
      if (!inFlow(getComputedStyle(child.el))) return false
      const rect = child.el.getBoundingClientRect()
      if (rect.top < previousBottom - 1) return false
      previousBottom = Math.max(previousBottom, rect.bottom)
    }
    return true
  }
  const structureRowLayoutResizable = (node: StructureNode, region: StructureRegion): boolean => {
    if (region.layout !== "row" || !horizontalStructureWritingMode(node, region)) return false
    const regionStyle = getComputedStyle(region.el)
    if (
      !regionStyle.display.includes("flex") ||
      regionStyle.flexDirection !== "row" ||
      regionStyle.flexWrap !== "nowrap"
    )
      return false
    return connectedStructureNodes(region).every(
      (child) => !availableEl(child.el) || inFlow(getComputedStyle(child.el)),
    )
  }
  /** Today's rules for a width a save can persist: an in-flow stack or row. */
  const widthResizable = (node: StructureNode, region: StructureRegion) =>
    structureTransformResizable(node) &&
    (structureStackLayoutResizable(node, region) || structureRowLayoutResizable(node, region))
  const heightResizable = (node: StructureNode, region: StructureRegion): boolean => {
    const row = structureRowLayoutResizable(node, region)
    if (!row && !structureStackLayoutResizable(node, region)) return false
    const regionStyle = getComputedStyle(region.el)
    if (regionStyle.display.includes("flex"))
      return /^(?:normal|start|flex-start|stretch)$/.test(
        row ? regionStyle.alignItems : regionStyle.justifyContent,
      )
    if (regionStyle.display.includes("grid")) {
      const self = getComputedStyle(node.el).alignSelf
      const alignment = self && self !== "auto" ? self : regionStyle.alignItems
      return structureGridHasSingleColumn(regionStyle) && /^(?:start|flex-start)$/.test(alignment)
    }
    return true
  }
  const structureWidthName = (node: StructureNode): string =>
    structureAttribute(node.prefix, "width")
  const structureSizeName = (node: StructureNode): string => structureAttribute(node.prefix, "size")
  const structureHeightName = (node: StructureNode): string =>
    structureAttribute(node.prefix, "height")
  const currentStructureWidth = (node: StructureNode): number | null => {
    const raw = node.el.getAttribute(structureWidthName(node))
    return raw === null ? null : Number.parseInt(raw, 10)
  }
  const currentStructureHeight = (node: StructureNode): number | null => {
    const raw = node.el.getAttribute(structureHeightName(node))
    return raw === null ? null : Number.parseInt(raw, 10)
  }
  const sizingOf = (node: StructureNode) =>
    structuralSizingOf(
      node.el,
      structureSizeName(node),
      structureWidthName(node),
      structureHeightName(node),
    )
  const clearEmptyStyle = (el: HTMLElement) => {
    if (!(el.getAttribute("style") || "").trim()) el.removeAttribute("style")
  }
  const applyStructureWidth = (node: StructureNode, width: number | null) => {
    node.el.removeAttribute(structureSizeName(node))
    const widthName = structureWidthName(node)
    if (width === null) {
      node.el.removeAttribute(widthName)
      node.el.style.removeProperty(STRUCTURAL_WIDTH_PROPERTY)
      clearEmptyStyle(node.el)
      return
    }
    node.el.setAttribute(widthName, String(width))
    node.el.style.setProperty(STRUCTURAL_WIDTH_PROPERTY, `${width}%`)
  }
  const applyStructureHeight = (node: StructureNode, height: number | null) => {
    const heightName = structureHeightName(node)
    if (height === null) {
      node.el.removeAttribute(heightName)
      node.el.style.removeProperty(STRUCTURAL_HEIGHT_PROPERTY)
      clearEmptyStyle(node.el)
      return
    }
    node.el.setAttribute(heightName, String(height))
    node.el.style.setProperty(STRUCTURAL_HEIGHT_PROPERTY, `${height}px`)
  }
  const structureWidthFits = (
    node: StructureNode,
    region: StructureRegion,
    width: number,
  ): boolean => {
    const contentWidth = structureContentWidth(region)
    if (!(contentWidth > 0)) return false
    const expected = (contentWidth * width) / 100
    return Math.abs(node.el.offsetWidth - expected) <= Math.max(2, expected * 0.02)
  }
  const structureHeightFits = (node: StructureNode, height: number): boolean =>
    Math.abs(node.el.offsetHeight - height) <= Math.max(2, height * 0.02) &&
    node.el.scrollHeight <= node.el.clientHeight + 1
  interface StructureHeightClipOverflow {
    top: number
    bottom: number
    /** The ancestor's own hidden scroll overflow (CSS px). The node's footprint misses
     *  what a taller node pushes out instead: later siblings, and container padding. */
    scroll: number
  }
  type StructureHeightChainBaseline = Map<HTMLElement, StructureHeightClipOverflow>
  const structureHeightClipOverflow = (
    node: StructureNode,
    ancestor: HTMLElement,
  ): StructureHeightClipOverflow => {
    const ancestorRect = ancestor.getBoundingClientRect()
    const screenScaleY = ancestor.offsetHeight > 0 ? ancestorRect.height / ancestor.offsetHeight : 1
    const clipTop = ancestorRect.top + ancestor.clientTop * screenScaleY
    const clipBottom = clipTop + ancestor.clientHeight * screenScaleY
    let top = node.el.getBoundingClientRect().top
    let bottom = node.el.getBoundingClientRect().bottom
    for (const element of Array.from(node.el.querySelectorAll<HTMLElement>("*"))) {
      const rect = element.getBoundingClientRect()
      if (!(rect.width > 0 || rect.height > 0)) continue
      top = Math.min(top, rect.top)
      bottom = Math.max(bottom, rect.bottom)
    }
    return {
      top: Math.max(0, clipTop - top),
      bottom: Math.max(0, bottom - clipBottom),
      scroll: Math.max(0, ancestor.scrollHeight - ancestor.clientHeight),
    }
  }
  const clippingAncestors = (node: StructureNode): HTMLElement[] => {
    const out: HTMLElement[] = []
    for (let a = node.el.parentElement; a && a !== document.body; a = a.parentElement)
      if (/^(?:hidden|clip)$/.test(getComputedStyle(a).overflowY)) out.push(a)
    return out
  }
  const structureHeightChainBaseline = (node: StructureNode): StructureHeightChainBaseline =>
    new Map(clippingAncestors(node).map((a) => [a, structureHeightClipOverflow(node, a)]))
  /** A new height fits every ancestor that has one, and newly overflows nothing that
   *  clips: an authored CSS-height wrapper outside Derive's sizing contract included. */
  const structureHeightChainFits = (
    node: StructureNode,
    baseline: StructureHeightChainBaseline,
  ): boolean => {
    for (let n: StructureNode | null = node; n; n = parentStructureNode(n)) {
      const height = currentStructureHeight(n)
      if (height !== null && !structureHeightFits(n, height)) return false
    }
    return clippingAncestors(node).every((ancestor) => {
      const now = structureHeightClipOverflow(node, ancestor)
      const before = baseline.get(ancestor) ?? { top: 0, bottom: 0, scroll: 0 }
      return (
        now.top <= before.top + 1 &&
        now.bottom <= before.bottom + 1 &&
        now.scroll <= before.scroll + 1
      )
    })
  }
  /** Size a node, measuring with its own transition off (an authored width
   *  transition reports the OLD geometry for its first frame). */
  const withoutTransition = <T>(node: StructureNode, fn: () => T): T => {
    const value = node.el.style.getPropertyValue("transition")
    const priority = node.el.style.getPropertyPriority("transition")
    node.el.style.setProperty("transition", "none", "important")
    void node.el.offsetWidth
    try {
      return fn()
    } finally {
      if (value) node.el.style.setProperty("transition", value, priority)
      else node.el.style.removeProperty("transition")
      clearEmptyStyle(node.el)
    }
  }
  /** Whether a node's current width/height is one its authored layout honours. */
  const sizingHolds = (
    node: StructureNode,
    region: StructureRegion,
    baseline: StructureHeightChainBaseline,
  ): boolean => {
    const width = currentStructureWidth(node)
    const height = currentStructureHeight(node)
    return (
      (width === null ||
        (widthResizable(node, region) && structureWidthFits(node, region, width))) &&
      (height === null || (heightResizable(node, region) && structureHeightFits(node, height))) &&
      structureHeightChainFits(node, baseline)
    )
  }

  /* -- what is a block, and what is it called -- */
  const SLIDE_SEL = "[data-derive-slide],.slide"
  const classSig = (el: Element) =>
    Array.from(el.classList)
      .filter((c) => !c.startsWith("derive-"))
      .sort()
      .join(" ")
  const lookAlikes = (el: Element): HTMLElement[] => {
    const parent = el.parentElement
    if (!parent || srcOf(el) === null || srcOf(parent) === null) return []
    const sig = classSig(el)
    return Array.from(parent.children).filter(
      (c): c is HTMLElement =>
        c instanceof HTMLElement &&
        c.localName === el.localName &&
        srcOf(c) !== null &&
        classSig(c) === sig,
    )
  }
  // Prose repeats too, but a paragraph or a heading is words: it stays text to click.
  const PROSE = "p,h1,h2,h3,h4,h5,h6,blockquote,pre,figcaption,dd,dt,td,th"
  const repeats = (el: HTMLElement): boolean =>
    !el.matches(SLIDE_SEL) &&
    !el.matches(PROSE) &&
    !readonlyAt(el) &&
    !el.hasAttribute(GEN_ATTR) &&
    lookAlikes(el).length > 1 &&
    /^(?:block|flex|grid|list-item|table|table-row|flow-root)$/.test(getComputedStyle(el).display)
  /** A block, on screen (or `anywhere`: naming a change on another slide). */
  const isMovable = (el: Element, anywhere = false): boolean =>
    el instanceof HTMLElement &&
    el !== document.body &&
    !el.closest(".derive-edit-ui") &&
    (!!nodeOf(el) || repeats(el)) &&
    (anywhere || availableEl(el))
  /** The innermost block at or above `el`, or null. */
  const blockOf = (el: Element | null | undefined): HTMLElement | null => {
    if (!blocksOn) return null
    for (let e = el ?? null; e && e !== document.body; e = e.parentElement)
      if (e instanceof HTMLElement && isMovable(e)) return e
    return null
  }
  const parentBlock = (el: HTMLElement) => blockOf(el.parentElement)
  /** The siblings a block moves among, itself included. */
  const siblingsOf = (el: HTMLElement): HTMLElement[] => {
    const node = nodeOf(el)
    const region = node && regionForStructureNode(node)
    return region ? connectedStructureNodes(region).map((n) => n.el) : lookAlikes(el)
  }
  /** Which way siblings flow on screen: the arrows and the drag follow it. */
  const axisOf = (els: readonly Element[]): "x" | "y" => {
    const centers = els.map((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    const spread = (k: "x" | "y") =>
      Math.max(...centers.map((c) => c[k])) - Math.min(...centers.map((c) => c[k]))
    return els.length > 1 && spread("x") > spread("y") ? "x" : "y"
  }
  const KIND_NAMES: Record<string, string> = {
    heading: "Title",
    label: "Label",
    media: "Image",
    image: "Image",
  }
  /** A block that opens with a heading (an article's section) is called by it. */
  const headingName = (el: HTMLElement): string => {
    const first = Array.from(el.children).find((c) => !c.classList.contains("derive-edit-ui"))
    return first?.matches("h1,h2,h3,h4,h5,h6,[role=heading]") ? clipText(plainOf(first), 40) : ""
  }
  const nameOf = (el: HTMLElement): string => {
    const slides = slideEls()
    if (slides.includes(el)) return `Slide ${slides.indexOf(el) + 1}`
    const kind = nodeOf(el)?.kind
    if (kind) return KIND_NAMES[kind] ?? (headingName(el) || "Section")
    const same = lookAlikes(el)
    const tag = el.localName
    if (tag !== "li" && tag !== "tr") {
      const heading = headingName(el)
      if (heading) return heading
    }
    if (same.length < 2) return "Block"
    const noun =
      tag === "li"
        ? "Item"
        : tag === "tr"
          ? "Row"
          : /^(?:img|figure|picture)$/.test(tag)
            ? "Image"
            : /\bcol(?:umn)?s?\b|-col\b/i.test(classSig(el))
              ? "Column"
              : "Card"
    return `${noun} ${same.indexOf(el) + 1}`
  }
  const plainOf = (root: Node): string => {
    let s = ""
    const walk = (n: Node) => {
      for (let c = n.firstChild; c; c = c.nextSibling)
        if (c.nodeType === 3) s += c.nodeValue
        else if (c instanceof Element && !c.matches(".derive-edit-ui"))
          if (c.localName === "br") s += " "
          else walk(c)
    }
    walk(root)
    return s.replace(/\s+/g, " ").trim()
  }
  const clipText = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
  /** Before and after of a text change, each clipped to `n` around where they first
   *  differ: a change past the first words of a long paragraph still shows. */
  const clipPair = (a: string, b: string, n = 60): [string, string] => {
    let p = 0
    while (p < a.length && p < b.length && a[p] === b[p]) p++
    const cut = (s: string) => {
      if (s.length <= n) return s
      const from = Math.max(0, Math.min(p - 20, s.length - n + 1))
      if (!from) return `${s.slice(0, n - 1)}…`
      if (from + n - 1 >= s.length) return `…${s.slice(from)}`
      return `…${s.slice(from, from + n - 2)}…`
    }
    return [cut(a), cut(b)]
  }
  /** How a change names a block: its heading's words, else its name. */
  const titleOf = (el: HTMLElement) =>
    clipText(plainOf(el.querySelector("h1,h2,h3,h4,h5,h6") ?? document.createElement("i")), 40) ||
    nameOf(el)
  /** Slide 2 › Section › Card 3: the slide (when there is one), then every block. */
  const crumbsOf = (el: HTMLElement): { name: string; el: HTMLElement | null }[] => {
    const chain: { name: string; el: HTMLElement | null }[] = []
    for (let b: HTMLElement | null = el; b; b = parentBlock(b))
      chain.unshift({ name: nameOf(b), el: b })
    const slides = slideEls()
    const at = slides.length > 1 ? slideOfEl(el, slides) : null
    if (at !== null) chain.unshift({ name: `Slide ${at + 1}`, el: null })
    return chain
  }

  /* -- chrome: the hover outline + name tag, the selection box + handles, the pill -- */
  const chromeEl = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = "") => {
    const el = document.createElement(tag)
    el.className = cls
    el.textContent = text
    return el
  }
  const blockHoverBox = chromeEl("div", "derive-edit-ui derive-block-hover")
  const blockTag = chromeEl("span", "derive-block-tag")
  blockHoverBox.append(blockTag)
  const blockBox = chromeEl("div", "derive-edit-ui derive-block-box")
  const blockRzE = chromeEl("button", "derive-block-rz derive-block-rz-e")
  blockRzE.setAttribute("aria-label", "Resize width (double-click for auto)")
  const blockRzSe = chromeEl("button", "derive-block-rz derive-block-rz-se")
  blockRzSe.setAttribute("aria-label", "Resize width and height (double-click for auto)")
  const blockSize = chromeEl("span", "derive-block-size")
  blockBox.append(blockRzE, blockRzSe, blockSize)
  const pill = chromeEl("div", "derive-edit-ui derive-block-pill")
  pill.setAttribute("role", "toolbar")
  pill.setAttribute("aria-label", "Block actions")
  const pillButton = (label: string, title: string, text: string, cls = "") => {
    const b = chromeEl("button", cls, text)
    b.type = "button"
    b.title = title
    b.setAttribute("aria-label", label)
    return b
  }
  const pillName = pillButton("Drag to move", "Drag to move", "", "derive-block-name")
  const pillPrev = pillButton("Move earlier", "Move earlier (Option+Arrow)", "←")
  const pillNext = pillButton("Move later", "Move later (Option+Arrow)", "→")
  const pillDup = pillButton("Duplicate", "Duplicate (⌘D)", "⧉ Duplicate")
  const pillDel = pillButton("Delete", "Delete (⌫)", "Delete", "derive-block-del")
  const pillMore = pillButton("More options", "Path and exact width", "⋯")
  const pillDiv = () => chromeEl("span", "derive-block-div")
  pill.append(
    pillName,
    pillDiv(),
    pillPrev,
    pillNext,
    pillDiv(),
    pillDup,
    pillDel,
    pillDiv(),
    pillMore,
  )
  ;(document.body || document.documentElement).append(blockHoverBox, blockBox, pill)
  for (const el of [blockHoverBox, blockBox, pill]) ownChrome(el)

  let blocksOn = false
  let blockSel: HTMLElement | null = null
  let blockHover: HTMLElement | null = null
  let blockPaintTick = 0
  let blockObserver: MutationObserver | null = null
  /** Each parent's children before the person first rearranged them (Discard and the
   *  changes list compare against these; a revert puts them back). */
  let kidsSnap = new Map<HTMLElement, ChildNode[]>()
  /** The block a person last moved within each parent, to name the move. */
  let lastMoved = new Map<HTMLElement, HTMLElement>()
  let blockClip: { el: HTMLElement; copy: boolean } | null = null
  interface BlockDrag {
    el: HTMLElement
    pointerId: number
    x0: number
    y0: number
    before: ChildNode[] | null
    /** Picked up by the pill's name or the hover tag, which hide as it's picked. */
    chrome: boolean
  }
  let blockDrag: BlockDrag | null = null
  interface BlockResize {
    mode: "width" | "both"
    pointerId: number
    node: StructureNode
    region: StructureRegion
    initial: Extract<HistoryEntry, { kind: "structural-sizing" }>
    x0: number
    y0: number
    w0: number
    h0: number
    width: number
    height: number
    /** The node's own transition, off while the drag previews. */
    transition: [string, string]
    unit: number
    scaleY: number
    baseline: StructureHeightChainBaseline
    moved: boolean
  }
  let blockResize: BlockResize | null = null
  let suppressClick = false

  const placeBox = (box: HTMLElement, el: HTMLElement | null) => {
    const r = el?.getBoundingClientRect()
    if (!el || !r || !(r.width || r.height)) {
      box.style.display = "none"
      return
    }
    box.style.display = "block"
    box.style.left = `${r.left + (window.scrollX || 0)}px`
    box.style.top = `${r.top + scrollTop()}px`
    box.style.width = `${r.width}px`
    box.style.height = `${r.height}px`
  }
  /** What the selected block can be resized along, by today's rules. */
  const resizeOf = (el: HTMLElement) => {
    const node = nodeOf(el)
    const region = node && regionForStructureNode(node)
    if (!node || !region || !widthResizable(node, region)) return null
    return { node, region, both: heightResizable(node, region) }
  }
  const paintBlocks = () => {
    const hover = editOn && blockHover !== blockSel && !blockDrag ? blockHover : null
    placeBox(blockHoverBox, hover?.isConnected ? hover : null)
    if (hover?.isConnected) {
      blockTag.textContent = `⠿ ${nameOf(hover)}`
      // No room above the block: the tag tucks inside its corner.
      blockHoverBox.classList.toggle("derive-block-tag-in", hover.getBoundingClientRect().top < 24)
    }
    const sel = editOn && blockSel?.isConnected ? blockSel : null
    placeBox(blockBox, sel)
    const rz = sel && !blockDrag ? resizeOf(sel) : null
    blockBox.setAttribute("data-resize", rz ? (rz.both ? "width both" : "width") : "")
    // The pill steps aside for typing, dragging and resizing.
    if (!sel || blockDrag || blockResize || editingCaret()) {
      pill.style.display = "none"
      return
    }
    const siblings = siblingsOf(sel)
    const i = siblings.indexOf(sel)
    const x = axisOf(siblings) === "x"
    pillName.innerHTML = ""
    pillName.append(chromeEl("span", "", "⠿"), nameOf(sel))
    pillPrev.textContent = x ? "←" : "↑"
    pillNext.textContent = x ? "→" : "↓"
    pillPrev.disabled = i <= 0
    pillNext.disabled = i < 0 || i >= siblings.length - 1
    pill.style.display = "flex"
    // Just outside the block: above it, or below when there's no room; always on screen.
    const r = sel.getBoundingClientRect()
    const w = pill.offsetWidth
    const h = pill.offsetHeight
    let top = r.top - h - 10
    if (top < 4) top = r.bottom + 10
    top = Math.max(4, Math.min(innerHeight - h - 4, top))
    const left = Math.max(4, Math.min(innerWidth - w - 4, r.left - 1))
    pill.style.left = `${left + (window.scrollX || 0)}px`
    pill.style.top = `${top + scrollTop()}px`
  }
  const schedulePaintBlocks = () => {
    if (blockPaintTick) return
    blockPaintTick = requestAnimationFrame(() => {
      blockPaintTick = 0
      if (blockSel && !(blockSel.isConnected && availableEl(blockSel))) blockSel = null
      if (blockHover && !blockHover.isConnected) blockHover = null
      paintBlocks()
    })
  }
  refreshResizeUi = () => {
    paintResizeUi()
    paintBlocks()
  }
  hasSelectedResize = () => !!resizeSelectedEl || !!blockSel
  const setBlockHover = (el: HTMLElement | null) => {
    if (el === blockHover) return
    blockHover = el
    paintBlocks()
  }
  const selectBlock = (el: HTMLElement | null) => {
    blockSel = el
    if (el) {
      clearResizeUi()
      setEditHover(null)
    }
    paintBlocks()
    scheduleDirty()
  }
  /** Put the caret down and leave text: nothing typed next may land anywhere. */
  const dropCaret = () => {
    const focused = editingCaret()
    if (focused) focused.blur()
    window.getSelection()?.removeAllRanges()
  }

  /* -- rearranging: moves, drags, duplicates, deletes and paste are one gesture -- */
  const kidsOf = (el: Element): ChildNode[] =>
    Array.from(el.childNodes).filter(
      (n) => !(n instanceof Element && n.classList.contains("derive-edit-ui")),
    )
  const setKids = (el: Element, nodes: readonly ChildNode[]) => {
    const chrome = Array.from(el.children).filter((c) => c.classList.contains("derive-edit-ui"))
    el.replaceChildren(...nodes, ...chrome)
  }
  const sameKids = (a: readonly ChildNode[], b: readonly ChildNode[]) =>
    a.length === b.length && a.every((n, i) => n === b[i])
  const snapKids = (el: HTMLElement) => {
    if (!kidsSnap.has(el)) kidsSnap.set(el, kidsOf(el))
  }
  /** Siblings slide from where they were to where they are now. Whether anything
   *  moved on screen at all is the answer. */
  const flip = (parent: Element, fn: () => void): boolean => {
    const kids = Array.from(parent.children).filter(
      (c): c is HTMLElement => c instanceof HTMLElement && !c.classList.contains("derive-edit-ui"),
    )
    const before = new Map(kids.map((k) => [k, k.getBoundingClientRect()]))
    fn()
    const still = matchMedia?.("(prefers-reduced-motion: reduce)").matches
    let moved = false
    for (const k of kids) {
      const was = before.get(k)
      if (!was || !k.isConnected) continue
      const now = k.getBoundingClientRect()
      const dx = was.left - now.left
      const dy = was.top - now.top
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
      moved = true
      if (still) continue
      const style = rawStyle(k)
      k.style.transition = "none"
      k.style.transform = `translate(${dx}px,${dy}px)`
      requestAnimationFrame(() => {
        k.style.transition = "transform .18s ease"
        k.style.transform = ""
        window.setTimeout(() => {
          if (!k.classList.contains("derive-block-dragging")) restoreStyle(k, style)
        }, 200)
      })
    }
    return moved
  }
  /** Run one rearrangement of `parents` as a single history step. A move the page
   *  doesn't show (CSS order, absolute positions) is put back rather than saved. */
  const rearrange = (parents: HTMLElement[], fn: () => void, mustShow = false): boolean => {
    for (const p of parents) snapKids(p)
    const before = parents.map((el) => ({ el, nodes: kidsOf(el) }))
    const shown = flip(parents[0] as HTMLElement, fn)
    if (before.every(({ el, nodes }) => sameKids(kidsOf(el), nodes))) return false
    if (mustShow && !shown) {
      for (const { el, nodes } of before) setKids(el, nodes)
      post({ type: "edit-blocked", reason: "layout" })
      return false
    }
    remember({ kind: "children", lists: before })
    markBlocksChanged()
    return true
  }
  const markBlocksChanged = () => {
    if (lastDirty <= 0) {
      lastDirty = 1
      // A partial optimistic state must never suppress the next full one.
      lastState = ""
      post({ type: "edit-state", dirty: 1, canUndo: true })
    }
    paintBlocks()
    scheduleDirty()
  }
  /** Move the selected block one place along its siblings. */
  const moveBlock = (direction: -1 | 1) => {
    const el = blockSel
    const parent = el?.parentElement
    if (!el || !parent) return
    const siblings = siblingsOf(el)
    const i = siblings.indexOf(el)
    const j = i + direction
    if (i < 0 || j < 0 || j >= siblings.length) return
    const order = [...siblings]
    order.splice(i, 1)
    order.splice(j, 0, el)
    if (rearrange([parent], () => reorderInPlace(order), true)) lastMoved.set(parent, el)
    paintBlocks()
  }
  const duplicateBlock = () => {
    const el = blockSel
    const parent = el?.parentElement
    if (!el || !parent) return
    const copy = el.cloneNode(true) as HTMLElement
    copy.classList.remove("derive-edited", "derive-edit-hover", "derive-block-dragging")
    for (const armed of Array.from(copy.querySelectorAll("[data-derive-editable]"))) {
      armed.removeAttribute("contenteditable")
      armed.removeAttribute("data-derive-editable")
      armed.classList.remove("derive-edited")
    }
    rearrange([parent], () => el.after(copy))
    selectBlock(copy)
  }
  const deleteBlock = () => {
    const el = blockSel
    const parent = el?.parentElement
    if (!el || !parent) return
    selectBlock(null)
    rearrange([parent], () => el.remove())
  }
  /* Cut, copy and paste a block: a save names a moved or copied element by its source
     id, so it can land on any slide. Paste goes after the selected block. */
  const clipBlock = (copy: boolean) => {
    const el = blockSel
    if (!el) return
    if (!copy) deleteBlock()
    blockClip = { el, copy }
  }
  const pasteBlock = () => {
    const at = blockSel
    const clip = blockClip
    const parent = at?.parentElement
    if (!clip || !at || !parent || (at === clip.el && !clip.copy)) return
    const el = clip.copy ? (clip.el.cloneNode(true) as HTMLElement) : clip.el
    const from = clip.el.parentElement
    rearrange(from && from !== parent && !clip.copy ? [parent, from] : [parent], () => at.after(el))
    blockClip = { el, copy: true }
    selectBlock(el)
  }
  pillPrev.addEventListener("click", () => moveBlock(-1))
  pillNext.addEventListener("click", () => moveBlock(1))
  pillDup.addEventListener("click", duplicateBlock)
  pillDel.addEventListener("click", deleteBlock)
  pillMore.addEventListener("click", () => post({ type: "edit-block-more" }))

  /** A click here places a caret: it is on words (the text a caret resolves to has a
   *  line box under the point), or inside the paragraph, heading or list item they
   *  belong to (beside its last word, even when it is itself the block). Anywhere
   *  else inside a block (its padding, the space beside a short label, the gap
   *  between its lines) picks the block up. */
  const takesCaret = (x: number, y: number, target: Element | null): boolean => {
    const hit = editNodeAt(x, y)
    if (!hit) return false
    const range = document.createRange()
    range.selectNodeContents(hit.node)
    if (
      Array.from(range.getClientRects()).some(
        (r) => x >= r.left - 3 && x <= r.right + 3 && y >= r.top - 2 && y <= r.bottom + 2,
      )
    )
      return true
    const text = editNodeVisibleAt(x, y)
    const box = text && editContainerFor(text.node)
    const block = blockOf(target)
    return !!box && (!block || box.matches(BLOCKS))
  }

  /* -- drag: from the pill's name, the hover tag, or a selected block's non-text area -- */
  const armDrag = (el: HTMLElement, e: PointerEvent, chrome = false) => {
    blockDrag = { el, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, before: null, chrome }
  }
  const startDragFromChrome = (e: PointerEvent, el: HTMLElement | null) => {
    if (!el || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dropCaret()
    window.focus()
    selectBlock(el)
    // No pointer capture: the pill and the tag hide while dragging, and moves over
    // the page reach these listeners anyway.
    armDrag(el, e, true)
  }
  pillName.addEventListener("pointerdown", (e) => startDragFromChrome(e, blockSel))
  blockTag.addEventListener("pointerdown", (e) => startDragFromChrome(e, blockHover))
  on(
    document,
    "pointerdown",
    (e) => {
      if (!editOn || e.button !== 0 || !e.isPrimary) return
      const t = asEl(e.target)
      if (!t || t.closest(".derive-edit-ui,img,[data-derive-resizable]")) return
      // Words take a caret, always: a block is picked up by what isn't words.
      if (takesCaret(e.clientX, e.clientY, t)) return
      const el = blockOf(t)
      if (!el) return
      // No caret and no text selection starts here, so keep the keyboard in this
      // document by hand: ⌥+arrows and Delete are for the block just picked.
      e.preventDefault()
      dropCaret()
      window.focus()
      selectBlock(el)
      armDrag(el, e)
    },
    true,
  )
  on(
    window,
    "pointermove",
    (e) => {
      const drag = blockDrag
      if (!drag || drag.pointerId !== e.pointerId) return
      e.preventDefault()
      const parent = drag.el.parentElement
      if (!parent) return
      if (!drag.before) {
        if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return
        snapKids(parent)
        drag.before = kidsOf(parent)
        drag.el.classList.add("derive-block-dragging")
        paintBlocks()
      }
      const siblings = siblingsOf(drag.el)
      const others = siblings.filter((s) => s !== drag.el)
      const x = axisOf(siblings) === "x"
      let at = others.findIndex((s) => {
        const r = s.getBoundingClientRect()
        return x ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2
      })
      if (at < 0) at = others.length
      const order = [...others]
      order.splice(at, 0, drag.el)
      if (order.some((s, k) => s !== siblings[k])) flip(parent, () => reorderInPlace(order))
      paintBlocks()
    },
    { passive: false },
  )
  const finishBlockDrag = (e: PointerEvent | null, cancel: boolean) => {
    const drag = blockDrag
    if (!drag || (e && drag.pointerId !== e.pointerId)) return false
    blockDrag = null
    drag.el.classList.remove("derive-block-dragging")
    const parent = drag.el.parentElement
    // The click that follows this pointerup (same task) is not a click: it ends a
    // drag, or lands wherever the hidden tag or pill used to be.
    if (e && (drag.before || drag.chrome)) {
      suppressClick = true
      window.setTimeout(() => {
        suppressClick = false
      }, 0)
    }
    if (drag.before && parent) {
      if (cancel || sameKids(kidsOf(parent), drag.before)) setKids(parent, drag.before)
      else {
        remember({ kind: "children", lists: [{ el: parent, nodes: drag.before }] })
        lastMoved.set(parent, drag.el)
        markBlocksChanged()
      }
    }
    paintBlocks()
    return !!drag.before
  }
  on(window, "pointerup", (e) => finishBlockDrag(e, false))
  on(window, "pointercancel", (e) => finishBlockDrag(e, true))

  /* -- resize: the right edge (width) and the corner (width and height), today's
        rules, with a live readout; a double-click on either puts it back to auto -- */
  const readout = (r: BlockResize) =>
    r.mode === "width" ? `${r.width}% wide` : `${r.width}% × ${r.height}px`
  const sizeChanged = (
    node: StructureNode,
    was: { size: string | null; width: string | null; height: string | null },
  ) =>
    node.el.getAttribute(structureSizeName(node)) !== was.size ||
    node.el.getAttribute(structureWidthName(node)) !== was.width ||
    node.el.getAttribute(structureHeightName(node)) !== was.height
  const beginBlockResize = (e: PointerEvent, mode: "width" | "both") => {
    const rz = blockSel && e.button === 0 ? resizeOf(blockSel) : null
    if (!rz || (mode === "both" && !rz.both)) return
    const { node, region } = rz
    const contentWidth = structureContentWidth(region)
    const scaleX =
      region.el.offsetWidth > 0
        ? region.el.getBoundingClientRect().width / region.el.offsetWidth
        : 0
    const scaleY =
      node.el.offsetHeight > 0 ? node.el.getBoundingClientRect().height / node.el.offsetHeight : 0
    if (!(contentWidth > 0 && scaleX > 0 && scaleY > 0)) return
    e.preventDefault()
    e.stopPropagation()
    const self = getComputedStyle(node.el).alignSelf
    const align = self && self !== "auto" ? self : getComputedStyle(region.el).alignItems
    const initial = sizingOf(node)
    const transition: [string, string] = [
      node.el.style.getPropertyValue("transition"),
      node.el.style.getPropertyPriority("transition"),
    ]
    // The drag is the preview: an authored transition would lag every frame of it.
    node.el.style.setProperty("transition", "none", "important")
    const width = Math.round((node.el.offsetWidth / contentWidth) * 100)
    blockResize = {
      mode,
      pointerId: e.pointerId,
      node,
      region,
      initial,
      x0: e.clientX,
      y0: e.clientY,
      w0: width,
      h0: node.el.offsetHeight,
      width,
      height: node.el.offsetHeight,
      transition,
      // Percentage points per screen pixel; a centered node grows on both sides.
      unit: (100 / (contentWidth * scaleX)) * (align.includes("center") ? 2 : 1),
      scaleY,
      baseline: structureHeightChainBaseline(node),
      moved: false,
    }
    blockBox.classList.add("derive-block-sizing")
    blockSize.textContent = readout(blockResize)
    paintBlocks()
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }
  blockRzE.addEventListener("pointerdown", (e) => beginBlockResize(e, "width"))
  blockRzSe.addEventListener("pointerdown", (e) => beginBlockResize(e, "both"))
  on(
    window,
    "pointermove",
    (e) => {
      const r = blockResize
      if (!r || r.pointerId !== e.pointerId) return
      e.preventDefault()
      const dx = e.clientX - r.x0
      const dy = e.clientY - r.y0
      if (!r.moved && Math.abs(dx) < 1 && Math.abs(dy) < 1) return
      r.moved = true
      r.width = Math.round(
        Math.min(MAX_STRUCTURAL_WIDTH_PCT, Math.max(MIN_STRUCTURAL_WIDTH_PCT, r.w0 + dx * r.unit)),
      )
      applyStructureWidth(r.node, r.width)
      if (r.mode === "both") {
        r.height = Math.round(
          Math.min(
            MAX_STRUCTURAL_HEIGHT_PX,
            Math.max(MIN_STRUCTURAL_HEIGHT_PX, r.h0 + dy / r.scaleY),
          ),
        )
        applyStructureHeight(r.node, r.height)
      }
      blockSize.textContent = readout(r)
      markBlocksChanged()
    },
    { passive: false },
  )
  const finishBlockResize = (e: PointerEvent | null, cancel: boolean) => {
    const r = blockResize
    if (!r || (e && r.pointerId !== e.pointerId)) return false
    blockResize = null
    blockBox.classList.remove("derive-block-sizing")
    const held =
      !cancel &&
      r.moved &&
      sizeChanged(r.node, r.initial) &&
      sizingHolds(r.node, r.region, r.baseline)
    if (held) {
      // Keep the new size; give the author's transition back.
      const [value, priority] = r.transition
      if (value) r.node.el.style.setProperty("transition", value, priority)
      else r.node.el.style.removeProperty("transition")
      clearEmptyStyle(r.node.el)
      remember(r.initial)
    } else {
      applyStructuralSizing(r.initial)
      if (r.moved && !cancel) post({ type: "edit-blocked", reason: "layout" })
    }
    paintBlocks()
    postDirty()
    return true
  }
  on(window, "pointerup", (e) => finishBlockResize(e, false))
  on(window, "pointercancel", (e) => finishBlockResize(e, true))
  /** Set (or with null, clear to auto) the selected block's width and/or height. */
  const setBlockSize = (width: number | null | undefined, height?: number | null) => {
    const rz = blockSel ? resizeOf(blockSel) : null
    if (!rz) return
    const { node, region } = rz
    const initial = sizingOf(node)
    const baseline = structureHeightChainBaseline(node)
    const held = withoutTransition(node, () => {
      if (width !== undefined) applyStructureWidth(node, width)
      if (height !== undefined && rz.both) applyStructureHeight(node, height)
      return sizingHolds(node, region, baseline)
    })
    if (!sizeChanged(node, initial)) return
    if (!held) {
      applyStructuralSizing(initial)
      post({ type: "edit-blocked", reason: "layout" })
      return
    }
    remember(initial)
    markBlocksChanged()
  }
  blockRzE.addEventListener("dblclick", () => setBlockSize(null))
  blockRzSe.addEventListener("dblclick", () => setBlockSize(null, null))
  cancelStructuralGesture = () => finishBlockResize(null, true) || finishBlockDrag(null, true)
  on(window, "blur", () => cancelStructuralGesture())
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancelStructuralGesture()
  })
  window.addEventListener("scroll", schedulePaintBlocks, true)
  window.addEventListener("resize", schedulePaintBlocks)

  /* -- keys on a selected block (no caret): ⌥+arrows move, Delete removes it -- */
  on(
    document,
    "keydown",
    (e) => {
      if (!editOn || !blockSel || e.defaultPrevented || e.isComposing || editingCaret()) return
      if (asEl(document.activeElement)?.closest("input,textarea,select,[contenteditable]")) return
      if (e.altKey && !e.metaKey && !e.ctrlKey && /^Arrow(?:Up|Down|Left|Right)$/.test(e.key)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        moveBlock(e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 1)
      } else if (
        !e.altKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        (e.key === "Delete" || e.key === "Backspace")
      ) {
        e.preventDefault()
        e.stopImmediatePropagation()
        deleteBlock()
      }
    },
    true,
  )

  /* -- the changes list: every element the person changed, against how it was when
        they first touched it, with a way back for each. Derived, never logged, so a
        revert is "put this element (or this parent's children) back" and whatever
        depends on it stays consistent. -- */
  interface Change {
    id: string
    where: string
    what?: string
    from?: string
    to?: string
    at: Element | null
    revert: () => void
  }
  const changeIds = new WeakMap<object, string>()
  let changeSeq = 0
  const changeId = (o: object) => {
    let id = changeIds.get(o)
    if (!id) {
      id = `c${++changeSeq}`
      changeIds.set(o, id)
    }
    return id
  }
  const htmlPlain = (html: string) => {
    const t = document.createElement("template")
    t.innerHTML = html
    return plainOf(t.content)
  }
  const textKindOf = (el: Element) =>
    /^h[1-6]$/.test(el.localName) ? "Heading" : el.localName === "li" ? "Item" : "Text"
  /** Where a change sits, in block names: "Card 3 · Heading", "Section", "Slide 2". */
  const whereOf = (el: HTMLElement, text: boolean): string => {
    const block = !blocksOn ? null : isMovable(el, true) ? el : blockOfAnywhere(el.parentElement)
    if (block === el) return nameOf(el)
    const tail = text ? textKindOf(el) : ""
    if (block) return [nameOf(block), tail].filter(Boolean).join(" · ")
    const slides = slideEls()
    const at = slides.length > 1 ? slideOfEl(el, slides) : null
    return tail || (at !== null ? `Slide ${at + 1}` : "Page")
  }
  const blockOfAnywhere = (el: Element | null): HTMLElement | null => {
    for (let e = el; e && e !== document.body; e = e.parentElement)
      if (e instanceof HTMLElement && isMovable(e, true)) return e
    return null
  }
  const describeKids = (parent: HTMLElement, snap: ChildNode[], now: ChildNode[]) => {
    const els = (list: ChildNode[]) =>
      list.filter((n): n is HTMLElement => n instanceof HTMLElement)
    const before = els(snap)
    const after = els(now)
    const parts: string[] = []
    for (const el of after)
      if (!before.includes(el))
        parts.push(
          `${before.some((b) => srcOf(b) === srcOf(el)) ? "Duplicated" : "Added"} ${titleOf(el)}`,
        )
    for (const el of before) if (!after.includes(el)) parts.push(`Deleted ${titleOf(el)}`)
    const was = before.filter((el) => after.includes(el))
    const kept = after.filter((el) => before.includes(el))
    const last = lastMoved.get(parent)
    const moved =
      last && kept.indexOf(last) !== was.indexOf(last) ? last : kept.find((el, i) => el !== was[i])
    if (moved) {
      const peers = (list: HTMLElement[]) =>
        list.filter((x) => x.localName === moved.localName && classSig(x) === classSig(moved))
      parts.push(
        `Moved ${titleOf(moved)} from ${peers(was).indexOf(moved) + 1} → ${peers(kept).indexOf(moved) + 1}`,
      )
    }
    return parts.join(", ") || "Rearranged"
  }
  const widthLabel = (size: string | null, width: string | null) =>
    width !== null ? `${width}%` : size ? `${size[0]?.toUpperCase()}${size.slice(1)}` : "Auto"
  const changes = (): Change[] => {
    const out: Change[] = []
    for (const t of editTargets) {
      if (!t.el.isConnected || (concatText(t.el) === t.origConcat && !hasFmt(t.el))) continue
      const was = htmlPlain(t.origHtml)
      const now = plainOf(t.el)
      const [from, to] = clipPair(was, now)
      out.push({
        id: changeId(t),
        where: whereOf(t.el, true),
        ...(was !== now ? { from, to } : { what: "Formatting" }),
        at: t.el,
        revert: () => {
          checkpoint(t.el)
          t.el.innerHTML = t.origHtml
          reregister(t, t.el)
        },
      })
    }
    for (const [parent, snap] of kidsSnap) {
      const now = kidsOf(parent)
      if (!parent.isConnected || sameKids(now, snap)) continue
      out.push({
        id: changeId(parent),
        where: whereOf(parent, false),
        what: describeKids(parent, snap, now),
        at: parent,
        revert: () => {
          remember({ kind: "children", lists: [{ el: parent, nodes: now }] })
          setKids(parent, snap)
        },
      })
    }
    for (const region of structureRegions)
      for (const node of region.nodes) {
        if (
          !node.el.isConnected ||
          !sizeChanged(node, {
            size: node.origSize,
            width: node.origWidth,
            height: node.origHeight,
          })
        )
          continue
        const attr = (name: string) => node.el.getAttribute(structureAttribute(node.prefix, name))
        const w0 = widthLabel(node.origSize, node.origWidth)
        const w1 = widthLabel(attr("size"), attr("width"))
        const h0 = node.origHeight === null ? "Auto" : `${node.origHeight}px`
        const h1 = attr("height") === null ? "Auto" : `${attr("height")}px`
        out.push({
          id: changeId(node),
          where: nameOf(node.el),
          what: [w0 !== w1 && `Width ${w0} → ${w1}`, h0 !== h1 && `Height ${h0} → ${h1}`]
            .filter(Boolean)
            .join(", "),
          at: node.el,
          revert: () => {
            remember(sizingOf(node))
            applyStructuralSizing({
              ...sizingOf(node),
              size: node.origSize,
              width: node.origWidth,
              height: node.origHeight,
              style: node.origStyle,
            })
          },
        })
      }
    for (const t of resizeTargets)
      if (t.el.isConnected && rawStyle(t.el) !== t.origStyle)
        out.push({
          id: changeId(t),
          where: t.el.localName === "img" ? "Image" : "Box",
          what: "Resized",
          at: t.el,
          revert: () => {
            checkpointStyle(t.el)
            restoreStyle(t.el, t.origStyle)
          },
        })
    for (const s of sceneEdits)
      out.push({
        id: changeId(s),
        where: `Scene ${s.wire.id.replace(/^scene-/, "")}`,
        what: {
          "scene-update": "Updated",
          "scene-move": "Moved",
          "scene-duplicate": "Duplicated",
          "scene-delete": "Deleted",
        }[s.wire.op],
        at: null,
        revert: () => {
          s.undo()
          sceneEdits = sceneEdits.filter((x) => x !== s)
          restoreActiveVideoScene(s.activeBefore)
        },
      })
    return out.sort((a, b) =>
      !a.at || !b.at || a.at === b.at
        ? Number(!a.at) - Number(!b.at)
        : a.at.compareDocumentPosition(b.at) & Node.DOCUMENT_POSITION_FOLLOWING
          ? -1
          : 1,
    )
  }
  const revertChange = (id: string) => {
    const change = changes().find((c) => c.id === id)
    if (!change) return
    cancelStructuralGesture()
    dropCaret()
    change.revert()
    lastBurst = null
    refreshResizeUi()
    postDirty()
  }
  const revealChange = (id: string) => {
    const el = changes().find((c) => c.id === id)?.at
    if (!(el instanceof HTMLElement)) return
    revealBlock(el)
    el.classList.remove("derive-block-flash")
    void el.offsetWidth
    el.classList.add("derive-block-flash")
    window.setTimeout(() => el.classList.remove("derive-block-flash"), 950)
  }
  /** What the host's panel shows for the selected block: its path and its width. */
  const blockInfo = () => {
    const el = blockSel
    if (!el) return null
    const rz = resizeOf(el)
    return {
      name: nameOf(el),
      crumbs: crumbsOf(el).map((c) => c.name),
      resizable: !!rz,
      width: rz ? currentStructureWidth(rz.node) : null,
    }
  }
  const selectCrumb = (index: number) => {
    if (!blockSel) return
    const crumb = crumbsOf(blockSel)[index]
    if (crumb) selectBlock(crumb.el)
  }
  /** A block's place in the source, as indices among stamped children from <body>:
   *  the same after a save reloads the page, where source ids are not. */
  const pathOf = (el: HTMLElement | null): number[] | null => {
    const out: number[] = []
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
      const i = Array.from(e.parentElement?.children ?? [])
        .filter((c) => srcOf(c) !== null)
        .indexOf(e)
      if (i < 0) return null
      out.unshift(i)
    }
    return el ? out : null
  }
  /** Select the block at `path` once it is on screen (a deck may still be fading
   *  its slide in), giving up after a second. */
  const selectPath = (path: unknown, tries = 20) => {
    if (!Array.isArray(path) || !editOn) return
    let el: Element | undefined = document.body
    for (const i of path)
      el = Array.from(el?.children ?? []).filter((c) => srcOf(c) !== null)[Number(i)]
    if (el instanceof HTMLElement && isMovable(el)) {
      // Keys go on meaning the block, as they did before the save.
      window.focus()
      selectBlock(el)
    } else if (el && tries > 0) window.setTimeout(() => selectPath(path, tries - 1), 50)
  }

  const enableBlocks = () => {
    blocksOn = elementEditsOn && !!srcSnap
    setStructureRegions(blocksOn ? scanStructureRegions() : [])
    kidsSnap = new Map()
    lastMoved = new Map()
    blockClip = null
    blockSel = null
    blockHover = null
    blockObserver?.disconnect()
    blockObserver = null
    if (blocksOn && window.MutationObserver) {
      blockObserver = new MutationObserver((records) => {
        // Painting our own boxes mutates only our chrome; that must not repaint.
        if (
          records.some((r) => !(r.target instanceof Element && r.target.closest(".derive-edit-ui")))
        )
          schedulePaintBlocks()
      })
      blockObserver.observe(document.body || document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style", "hidden", "aria-hidden", "inert"],
        childList: true,
        subtree: true,
      })
    }
    paintBlocks()
  }
  /** End the block session; `restore` puts every rearranged parent and size back. */
  const settleBlocks = (restore: boolean) => {
    cancelStructuralGesture()
    if (restore) {
      for (const [el, nodes] of kidsSnap) setKids(el, nodes)
      for (const region of structureRegions)
        for (const node of region.nodes)
          applyStructuralSizing({
            ...sizingOf(node),
            size: node.origSize,
            width: node.origWidth,
            height: node.origHeight,
            style: node.origStyle,
          })
    }
    blockObserver?.disconnect()
    blockObserver = null
    blocksOn = false
    kidsSnap = new Map()
    lastMoved = new Map()
    blockClip = null
    blockSel = null
    blockHover = null
    setStructureRegions([])
    paintBlocks()
  }

  const isBlockEl = (n: Node | null): boolean =>
    !!n && n.nodeType === 1 && BLOCK_TEXT_ELEMENTS.has((n as Element).tagName.toLowerCase())
  /** Whether the server projection puts whitespace between two adjacent text nodes:
   *  a block element closes or opens on the way from one to the other, or a block-level
   *  void (<br>, <hr>) or an empty block sits between them. */
  const blockSeam = (a: Text, b: Text): boolean => {
    const above = new Set<Node>()
    for (let n: Node | null = a.parentNode; n; n = n.parentNode) above.add(n)
    let common: Node | null = b.parentNode
    while (common && !above.has(common)) common = common.parentNode
    for (let n: Node | null = a.parentNode; n && n !== common; n = n.parentNode)
      if (isBlockEl(n)) return true
    for (let n: Node | null = b.parentNode; n && n !== common; n = n.parentNode)
      if (isBlockEl(n)) return true
    // Siblings-in-between: walk document order from a to b, one element at a time.
    const w = document.createTreeWalker(common ?? document, NodeFilter.SHOW_ELEMENT)
    w.currentNode = a
    for (let el = w.nextNode(); el; el = w.nextNode()) {
      if (el.contains(b)) break
      if (isBlockEl(el)) return true
    }
    return false
  }
  /** The mode was opened from the host's Edit verb on the live selection (as opposed
   *  to the header button, where the first click chooses the block), or reopened
   *  after a save with the block that was selected (`select`, see `pathOf`). */
  type EditEntry = { fromSelection?: boolean; select?: unknown }
  const setEditMode = (
    on: boolean,
    keep?: boolean,
    entry?: EditEntry,
    allowElementEdits = false,
  ) => {
    if (on === editOn) return
    editOn = on
    elementEditsOn = on && allowElementEdits
    if (on) {
      clearResizeUi()
      // The pre-edit snapshot every quote is built from. normalize() first so the
      // per-node offsets recorded at enable time can't be split later by typing.
      // "\n" between nodes only where the server projection has whitespace too: a
      // block element (pageText's BLOCK_TEXT_ELEMENTS, a <br> included) opens or
      // closes between them. An inline seam — the brackets of a citation around its
      // link, a <b> inside a sentence — renders as nothing, and a separator there
      // would make the context window sliced across it unmatchable.
      ;(document.body || document.documentElement).normalize()
      const nodes = textNodes(document.body)
      const starts = new Map<Text, number>()
      let full = ""
      let prev: Text | null = null
      for (const n of nodes) {
        if (prev && blockSeam(prev, n)) full += "\n"
        starts.set(n, full.length)
        full += n.nodeValue
        prev = n
      }
      full += "\n"
      editBase = { text: full, starts }
      srcSnap = stamped() ? snapshotSource(document.body) : null
      sceneEdits = []
      enableBlocks()
      enableResizeFocus()
      setHover(null)
      // Off-screen slides stop catching clicks meant for the slide on screen.
      maskOffscreenSlides()
      setEditHitTesting(true)
      // Entered FROM the document (Edit on a selection): land the caret on the words
      // the user already selected instead of making them click the same words a
      // second time. Deferred a frame so the host's chrome has settled and the
      // block's rect is final before revealBlock measures it.
      if (entry?.fromSelection)
        requestAnimationFrame(() => {
          if (!editOn) return
          const s = window.getSelection()
          const n = s && s.rangeCount > 0 ? s.getRangeAt(0).startContainer : null
          if (n && n.nodeType === 3) editActivate(n as Text, null)
        })
      // Back after a save reloaded the page: the block that was selected is again.
      if (entry?.select) requestAnimationFrame(() => selectPath(entry.select))
    } else {
      // `keep`: drop the editing chrome but leave the typed text standing. Used right
      // after a PUBLISH — the text on screen is what was just saved, and the version
      // swap will reload the frame a moment later; restoring here would flash the
      // pre-edit wording in between and make a successful save look like it failed.
      if (keep) settleEdits()
      else restoreEdits()
      editBase = null
      srcSnap = null
      releaseSource(document.body)
      setEditHover(null)
      unmaskSlides()
      setEditHitTesting(false)
      // History belongs to the session that made it. Carrying it across would offer
      // to undo into a document that has already been saved and reloaded.
      resetEditHistory()
      sceneEdits = []
      clearEditMention()
      post({ type: "edit-mention-close" })
    }
  }
  const disableTarget = (t: EditTarget) => {
    t.el.removeAttribute("contenteditable")
    t.el.removeAttribute("data-derive-editable")
    for (const ro of t.el.querySelectorAll("[data-derive-readonly]"))
      ro.removeAttribute("contenteditable")
    t.el.classList.remove("derive-edited")
    t.el.classList.remove("derive-edit-hover")
  }
  /** Leave the text exactly as typed; just remove the editing chrome. */
  const settleEdits = () => {
    for (const t of editTargets) if (document.contains(t.el)) disableTarget(t)
    editTargets = []
    resizeTargets = []
    restoreResizeFocus()
    clearResizeUi()
    settleBlocks(false)
    sceneEdits = []
    if (lastDirty !== 0) {
      lastDirty = 0
      post({ type: "edit-state", dirty: 0 })
    }
  }
  const restoreEdits = () => {
    const restoredScenes = sceneEdits.length > 0
    const activeSceneId = restoredScenes ? sceneEdits[0]?.activeBefore : undefined
    for (let i = sceneEdits.length - 1; i >= 0; i--) sceneEdits[i]?.undo()
    if (restoredScenes) restoreActiveVideoScene(activeSceneId)
    // Reconnect removed blocks before restoring text nested inside them.
    settleBlocks(true)
    for (const t of editTargets) {
      if (document.contains(t.el)) {
        if (concatText(t.el) !== t.origConcat || hasFmt(t.el)) {
          t.el.innerHTML = t.origHtml
          // innerHTML rebuilt the block's text nodes as NEW objects — re-register
          // them at their original offsets, or a Discarded block would refuse every
          // later click as "dynamic" (its nodes missing from the mode-entry map).
          reregister(t, t.el)
        }
        disableTarget(t)
      }
    }
    for (const t of resizeTargets) if (document.contains(t.el)) restoreStyle(t.el, t.origStyle)
    editTargets = []
    resizeTargets = []
    restoreResizeFocus()
    clearResizeUi()
    sceneEdits = []
    // Discard establishes a new clean baseline inside the still-open mode. History
    // from the abandoned timeline must not remain actionable: a second edit cycle
    // should begin exactly like the first, with neither stale Undo nor stale Redo.
    resetEditHistory()
    if (lastDirty !== 0) {
      lastDirty = 0
    }
    // Discard keeps the mode open: the restored page is a fresh starting point.
    if (editOn) enableBlocks()
    scheduleDirty()
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
  /* Regions the renderer marked `data-derive-readonly` (math, tables, images, generated
     labels and numbers, the author block, the reference list of a paper): a click there
     is refused with its own reason, and inside an armed block they stay inert islands. */
  const READONLY = "[data-derive-readonly]"
  const readonlyAt = (el: Element | null | undefined): boolean => !!el?.closest(READONLY)
  /** The read-only island a delete from the caret would reach first in `dir`, if the
   *  only thing between them is nothing (a character delete) or whitespace (a word or
   *  line delete). Chromium reports NO target range when a delete would remove a
   *  non-editable element whole, so the caret's neighbourhood is the only tell. */
  const islandBesideCaret = (
    t: Element,
    e: InputEvent,
    dir: "backward" | "forward",
  ): Element | null => {
    const sel = window.getSelection()
    if (!sel?.rangeCount || !sel.isCollapsed) return null
    const { startContainer: c, startOffset: o } = sel.getRangeAt(0)
    if (!t.contains(c)) return null
    const wide = /Word|Line|Entire/.test(e.inputType)
    let node: Node | null
    if (c.nodeType === 3) {
      const text = c.nodeValue ?? ""
      const between = dir === "backward" ? text.slice(0, o) : text.slice(o)
      if (between.length && !(wide && !between.trim())) return null
      node = dir === "backward" ? c.previousSibling : c.nextSibling
    } else {
      node = (dir === "backward" ? c.childNodes[o - 1] : c.childNodes[o]) ?? null
    }
    for (;;) {
      while (node && node.nodeType === 3 && !(node.nodeValue ?? "").trim())
        node = dir === "backward" ? node.previousSibling : node.nextSibling
      if (!(node instanceof Element)) return null
      if (node.matches(READONLY)) return node
      // Descend into a wrapper (an <em>, a link) whose edge is the island itself.
      node = dir === "backward" ? node.lastChild : node.firstChild
    }
  }
  /** Whether a delete is about to remove a read-only island: the caret steps over one,
   *  but Backspace beside it would still swallow it whole. */
  const deleteHitsReadonly = (t: Element, e: InputEvent): boolean => {
    const islands = t.querySelectorAll(READONLY)
    if (!islands.length) return false
    const ranges = typeof e.getTargetRanges === "function" ? e.getTargetRanges() : []
    for (const sr of ranges) {
      const r = document.createRange()
      try {
        r.setStart(sr.startContainer, sr.startOffset)
        r.setEnd(sr.endContainer, sr.endOffset)
      } catch (_e) {
        continue
      }
      for (const ro of islands) if (r.intersectsNode(ro)) return true
    }
    if (ranges.length) return false
    const it = e.inputType
    if (/Backward$/.test(it)) return !!islandBesideCaret(t, e, "backward")
    if (/Forward$/.test(it)) return !!islandBesideCaret(t, e, "forward")
    return false
  }
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
    if (readonlyAt(node.parentElement)) {
      post({ type: "edit-blocked", reason: "readonly" })
      return
    }
    let cand = editContainerFor(node)
    if (!cand) return
    // One editing host per run of words: typing goes to a block already armed around
    // them, and a block is never armed around an armed one (nested hosts let a run
    // of Backspace walk out of the words clicked into the neighbour's). Take the
    // largest piece of the block that holds the words and nothing armed.
    const armed = node.parentElement?.closest("[data-derive-editable]")
    if (armed instanceof HTMLElement) cand = armed
    else if (cand.querySelector("[data-derive-editable]")) {
      let el = node.parentElement as HTMLElement
      while (
        el.parentElement &&
        el.parentElement !== cand &&
        !el.parentElement.querySelector("[data-derive-editable]")
      )
        el = el.parentElement
      cand = el
    }
    // A page script made it: its words aren't in the source, so there's nowhere to
    // save them.
    if (srcSnap && cand.closest(`[${GEN_ATTR}]`)) {
      post({ type: "edit-blocked", reason: "dynamic" })
      return
    }
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
      for (const ro of cand.querySelectorAll(READONLY)) ro.setAttribute("contenteditable", "false")
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
    scheduleDirty()
  }
  /** The text node a point resolves to, or null where editing can't reach. */
  const editNodeAt = (
    x: number,
    y: number,
  ): { node: Text; caret: { node: Node; offset: number } } | null => {
    const c = caretAt(x, y)
    return c && c.node.nodeType === 3 ? { node: c.node as Text, caret: c } : null
  }
  /** Whether the text a caret hit resolved to is actually under the point. Caret hit
   *  testing snaps to the NEAREST text when the point is over empty space or over an
   *  overlay, so a click beside a slide's content could otherwise arm a block the
   *  pointer is nowhere near — and the next keystrokes would land there. */
  const textUnderPoint = (node: Text, x: number, y: number): boolean => {
    const within = (r: DOMRect | DOMRectReadOnly, pad: number) =>
      x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad
    const block = editContainerFor(node)
    if (block && within(block.getBoundingClientRect(), 2)) return true
    // Text can overflow its block (nowrap in a narrow box); its own line boxes count.
    const range = document.createRange()
    range.selectNodeContents(node)
    for (const r of Array.from(range.getClientRects())) if (within(r, 4)) return true
    return false
  }
  /** The text a click or hover at a point would edit, or null. Overlays over the
   *  words already left hit testing (setEditHitTesting); off-screen slides are
   *  masked (maskOffscreenSlides). */
  const editNodeVisibleAt = (
    x: number,
    y: number,
  ): { node: Text; caret: { node: Node; offset: number } } | null => {
    const hit = editNodeAt(x, y)
    return hit && textUnderPoint(hit.node, x, y) ? hit : null
  }
  /** An image under the pointer — the one editable thing here that isn't text. */
  const imageAt = (e: MouseEvent): HTMLImageElement | null => {
    const el = asEl(e.target)?.closest("img")
    return el instanceof HTMLImageElement ? el : null
  }
  const editClick = (e: MouseEvent) => {
    if (!editBase) return
    // The click that ends a drag lands wherever the pointer let go: it is not a click.
    if (suppressClick) {
      suppressClick = false
      return
    }
    // A keyboard-synthesized click (Enter/Space on a focused link) reports
    // clientX/clientY 0, which would resolve a caret at the frame's top-left and
    // silently arm an unrelated block. Editing is pointer-driven; ignore it.
    if (e.detail === 0 && e.clientX === 0 && e.clientY === 0) return
    const el0 = asEl(e.target)
    if (el0?.closest(".derive-edit-ui")) return
    // Never navigate while editing — a click on a link edits its text instead.
    if (el0?.closest("a[href]")) e.preventDefault()
    if (readonlyAt(el0)) {
      post({ type: "edit-blocked", reason: "readonly" })
      return
    }
    // Once a text block is active, a double click belongs to the browser's native
    // word selection. Re-focusing that same contenteditable from the click handler
    // collapses Chromium's just-created selection to a caret, leaving every
    // formatting command disabled. Let the selection stand and only publish its
    // contextual state after the native event has settled. A triple click takes the
    // whole element: the browser's own stops at a <br> inside a heading.
    const armed = el0?.closest("[data-derive-editable]")
    if (e.detail > 1 && armed) {
      if (e.detail === 3) window.getSelection()?.selectAllChildren(armed)
      selectResize(null)
      setResizeHover(null)
      window.setTimeout(scheduleDirty, 0)
      return
    }
    // A picture selects its direct-manipulation box. Replace is an explicit verb on
    // that box, leaving the corner grip free to mean resize on mouse and touch.
    const img = imageAt(e)
    if (img) {
      selectBlock(null)
      selectResize(img)
      return
    }
    // Words take a caret, always, in a block or not; what isn't words selects the
    // block it belongs to.
    const block = takesCaret(e.clientX, e.clientY, el0) ? null : blockOf(el0)
    selectBlock(block)
    if (block) return
    const hit = editNodeVisibleAt(e.clientX, e.clientY)
    if (el0?.closest(BLOCKED_EDIT)) {
      post({ type: "edit-blocked", reason: "control" })
      return
    }
    if (!hit) {
      selectResize(resizableAt(e.target))
      return
    }
    selectResize(null)
    setResizeHover(null)
    editActivate(hit.node, hit.caret)
  }

  // Text context in the host follows focus as well as selection. This makes Inspect
  // useful as soon as someone clicks into a paragraph, before they select words to
  // format. Defer focusout by one turn so focus moving within the frame settles first.
  on(document, "focusin", () => {
    if (editOn) scheduleDirty()
  })
  // Typing follows the click: when focus leaves a block for anywhere else in the page
  // (a link, a node, a handle, empty space), its caret goes too. Otherwise the
  // selection stays behind, and text input lands wherever the selection is. Focus
  // leaving the frame (the host's own buttons) keeps it.
  on(document, "focusout", (e) => {
    if (!editOn) return
    const block = asEl(e.target)?.closest("[data-derive-editable]")
    window.setTimeout(() => {
      scheduleDirty()
      if (!block || !document.hasFocus() || block.contains(document.activeElement)) return
      const sel = window.getSelection()
      if (sel?.anchorNode && block.contains(sel.anchorNode)) sel.removeAllRanges()
    }, 0)
  })

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
  // Where the pointer is now, read when the throttle fires (not where it entered).
  let editHoverAt: { x: number; y: number; target: EventTarget | null } | null = null
  on(document, "mousemove", (e) => {
    if (!editOn) return
    editHoverAt = { x: e.clientX, y: e.clientY, target: e.target }
    if (editHoverTick) return
    editHoverTick = window.setTimeout(() => {
      editHoverTick = 0
      const { x, y, target } = editHoverAt ?? { x: 0, y: 0, target: null }
      if (!editOn) return setEditHover(null)
      if (asEl(target)?.closest(".derive-edit-ui")) return
      setBlockHover(blockOf(asEl(target)))
      const resize = resizableAt(target)
      setResizeHover(resize)
      if (asEl(target)?.closest(BLOCKED_EDIT)) return setEditHover(null)
      if (readonlyAt(asEl(target))) return setEditHover(null)
      // Media uses the bounding box; text keeps the quieter block invitation.
      const overImg = asEl(target)?.closest("img")
      if (overImg instanceof HTMLElement) return setEditHover(null)
      // Through overlays, like the click that follows it — otherwise a deck's click
      // zone means the hover invitation never lights the block a click would open.
      const hit = editNodeVisibleAt(x, y)
      if (!hit) return setEditHover(null)
      const cand = editContainerFor(hit.node)
      // A block that's already editable wears the focus ring; don't double-decorate.
      setEditHover(cand && !cand.hasAttribute("data-derive-editable") ? cand : null)
    }, 50)
  })
  document.addEventListener("mouseleave", () => {
    setEditHover(null)
    setResizeHover(null)
    setBlockHover(null)
  })

  document.addEventListener(
    "beforeinput",
    (e: InputEvent) => {
      if (!editOn) return
      const t = asEl(e.target)?.closest("[data-derive-editable]")
      if (!t) return
      const it = e.inputType || ""
      if (it.indexOf("delete") === 0 && deleteHitsReadonly(t, e)) {
        e.preventDefault()
        post({ type: "edit-blocked", reason: "readonly" })
        return
      }
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
    detectEditMention()
  })
  // A click or arrow key can move the caret out of a token without changing text.
  // Close the host menu immediately rather than leaving a stale insertion target up.
  document.addEventListener("selectionchange", () => {
    if (editOn) detectEditMention()
  })

  /* ── Bold, italic, link ───────────────────────────────────────────────────────
     Everything else in this mode is plain text by design: the contenteditable is
     `plaintext-only`, and the server escapes every replacement. Formatting is the
     one exception, and it is deliberately narrow — emphasis and a link, on a run of
     words inside one block.

     The wrap is the EDITOR's, not the document's: a `[data-derive-fmt]` span holds
     the intent (and shows what it will look like) until the save turns it into a
     real tag. Nothing here touches the stored source; the save serializes these
     spans as the server's inline-tag tokens (source-tokens.ts). HTML pages only:
     Markdown and LaTeX write formatting as text.

     ⌘B/⌘I/⌘K, because those are the keys every writing tool binds. The frame owns
     the keyboard while a caret is in a block, so they can't reach the browser. */
  const applyFmt = (kind: "b" | "i" | "a", href?: string): void => {
    if (!srcSnap) {
      post({ type: "edit-blocked", reason: "format-text" })
      return
    }
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
      range.surroundContents(span)
    } catch (_e) {
      // A selection may start inside a link and end after it. Extract the selected
      // contents so the person's format action can still reach the stored source.
      try {
        span.appendChild(range.extractContents())
        range.insertNode(span)
      } catch (_fallbackError) {
        undoStack.pop()
        post({ type: "edit-blocked", reason: "format-range" })
        return
      }
    }
    // Return the writing context to the document after a host-side command. A
    // collapsed caret immediately after the formatted run is the natural place to
    // continue typing, and it keeps Inspect contextual instead of flashing back to
    // its empty state once the selection is consumed.
    try {
      block.focus({ preventScroll: true })
      const caret = document.createRange()
      caret.setStartAfter(span)
      caret.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(caret)
    } catch (_e) {
      window.getSelection()?.removeAllRanges()
    }
    scheduleDirty()
  }
  /** Enter: a line break at the caret, carried by the same editor span the other
   *  formatting uses (so one collect path handles all of it) and rendered by the
   *  real <br> inside it, so the line breaks on screen the moment it's typed. */
  const insertBreak = (): void => {
    if (!srcSnap) {
      post({ type: "edit-blocked", reason: "format-text" })
      return
    }
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) return
    const range = sel.getRangeAt(0)
    const el = range.startContainer
    const block = (el.nodeType === 1 ? (el as Element) : el.parentElement)?.closest(
      "[data-derive-editable]",
    )
    if (!(block instanceof HTMLElement)) return
    // A word selection can end past the block (a double click at the end of an inline
    // block); the break replaces only what is inside it.
    if (!block.contains(range.endContainer)) range.setEnd(block, block.childNodes.length)
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

  const hasFmt = (el: Element): boolean => !!el.querySelector(`[${FMT_ATTR}]`)

  const isHiSur = (ch: string | undefined): boolean =>
    !!ch && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdbff
  const isLoSur = (ch: string | undefined): boolean =>
    !!ch && ch.charCodeAt(0) >= 0xdc00 && ch.charCodeAt(0) <= 0xdfff

  // If the same wording appears several times, the frame knows which occurrence
  // the person edited. Send that fact with the quote. The server uses it only when
  // the stored projection has the same number of matches.
  const occurrenceHint = (exact: string, start: number) => {
    const base = editBase
    if (!base || base.text.slice(start, start + exact.length) !== exact) return {}
    const matches = findQuoteMatches(base.text, exact, 201)
    if (!matches.length || matches.length > 200) return {}
    const firstText = start + exact.length - exact.trimStart().length
    const index = matches.findIndex((match) => match.start === firstText)
    return index < 0 ? {} : { occurrence: index + 1, match_count: matches.length }
  }

  /* One changed text run → a quote edit built from the PRE-EDIT document text.
     Minimal diff (common prefix/suffix), then snapped OUT to word boundaries: the
     matcher's context join expects whitespace between prefix|exact|suffix, and whole
     words give the exact enough meat to be unambiguous. */
  const quoteEditFor = (
    orig: string,
    cur: string,
    docStart: number,
  ): {
    exact: string
    prefix: string
    suffix: string
    occurrence?: number
    match_count?: number
    new_text: string
  } | null => {
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
    if (!exact.trim()) {
      // An insertion or whitespace edit needs a neighboring word as its anchor.
      // Spaces can change layout, so do not drop the edit as a no-op.
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
      ...occurrenceHint(exact, docStart + p),
      new_text: newText,
    }
  }
  /** The wire shape of one collected text edit (Markdown and LaTeX). */
  interface WireEdit {
    quote: {
      exact: string
      prefix: string
      suffix: string
      occurrence?: number
      match_count?: number
    }
    new_text: string
  }
  interface WireElementEdit {
    op: "resize"
    target: Record<string, unknown>
    width: number
    height: number | "auto"
  }
  type WireChange = WireEdit | WireElementEdit | WireSceneEdit
  const wireEdit = (qe: {
    exact: string
    prefix: string
    suffix: string
    occurrence?: number
    match_count?: number
    new_text: string
  }): WireEdit => ({
    quote: {
      exact: qe.exact,
      prefix: qe.prefix,
      suffix: qe.suffix,
      occurrence: qe.occurrence,
      match_count: qe.match_count,
    },
    new_text: qe.new_text,
  })
  // The whole-block span. The original is the snapshot's own slice over the block, so
  // "\n" sits exactly where the server projection has whitespace (a block seam) and
  // offsets line up with editBase.text; the current nodes are joined by the same rule.
  // An inline seam (a <b> inside a word, a link before its period) joins with nothing:
  // a separator there made the quote unmatchable. The replacement's seam separators
  // collapse to single spaces (typed content never contains newlines).
  const blockEdit = (t: EditTarget, curNodes: Text[]): WireEdit | null => {
    const base = editBase
    const start = t.origStarts[0]
    const last = t.origValues.length - 1
    if (!base || start === undefined || last < 0) return null
    const orig = base.text.slice(
      start,
      (t.origStarts[last] ?? start) + (t.origValues[last] ?? "").length,
    )
    let cur = ""
    curNodes.forEach((n, i) => {
      const prev = curNodes[i - 1]
      if (prev && blockSeam(prev, n)) cur += "\n"
      cur += n.nodeValue ?? ""
    })
    const qe = quoteEditFor(orig, cur, start)
    return qe ? wireEdit({ ...qe, new_text: qe.new_text.replace(/\s*\n\s*/g, " ") }) : null
  }
  /* `uncaptured` counts blocks the user changed that produced NO edit — the host
     refuses to save a partial batch, because publishing some of the typing and
     letting the post-save reload wipe the rest is data loss dressed up as success.
     Only the all-or-nothing case used to be detectable (edits empty while dirty), so
     one lost block among several good ones went out silently. */
  const collectEdits = (): { edits: WireChange[]; dirty: number; uncaptured: number } => {
    const edits: WireChange[] = []
    let dirty = 0
    let uncaptured = 0
    for (const t of editTargets) {
      if (!document.contains(t.el)) continue
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
      const be = blockEdit(t, curNodes)
      if (be) edits.push(be)
      else uncaptured++
    }
    for (const t of resizeTargets) {
      if (!document.contains(t.el) || rawStyle(t.el) === t.origStyle) continue
      dirty++
      const width = Math.round(Number.parseFloat(t.el.style.width))
      const rawHeight = t.el.style.height
      const height = t.autoHeight ? "auto" : Math.round(Number.parseFloat(rawHeight))
      if (
        !Number.isFinite(width) ||
        width < 24 ||
        width > 8192 ||
        (height !== "auto" && (!Number.isFinite(height) || height < 24 || height > 8192))
      ) {
        uncaptured++
        continue
      }
      edits.push({ op: "resize", target: t.selector, width, height })
    }
    for (const entry of sceneEdits) edits.push(entry.wire)
    dirty += sceneEdits.length
    return { edits, dirty, uncaptured }
  }

  /* The exact-source save (stamped pages), atomic: content ops from the DOM against
     the entry snapshot, and one attrs op per element whose size or structural layout
     changed — the properties the editor owns over the author's own style text, and
     the layout attributes by their canonical names (a legacy deck's runtime ones
     included: the server persists that structure with the save). */
  const collectOps = (snap: SrcSnapshot) => {
    // Only what the person changed is theirs to save: the page's own scripts keep
    // running while you edit (a deck's "3 / 12" counter follows the slide on screen).
    // Typed-in blocks with any source inside them, and every rearranged parent.
    const touched = new Set<Element>()
    const stampedAbove = (el: Element) => {
      let e: Element | null = el
      while (e && e !== document.body && srcOf(e) === null) e = e.parentElement
      if (e) touched.add(e)
    }
    for (const t of editTargets) {
      stampedAbove(t.el)
      for (const d of Array.from(t.el.querySelectorAll(`[${SRC_ATTR}]`))) touched.add(d)
    }
    for (const parent of kidsSnap.keys()) stampedAbove(parent)
    const { ops, ok } = collectSourceOps(document.body, snap, touched)
    let uncaptured = ok && !blockResize ? 0 : 1
    const changed = new Map<
      Element,
      {
        orig: string | null
        style: Record<string, string | null>
        attrs: Record<string, string | null>
      }
    >()
    const change = (el: Element, orig: string | null) => {
      const entry = changed.get(el) ?? { orig, style: {}, attrs: {} }
      changed.set(el, entry)
      return entry
    }
    for (const t of resizeTargets) {
      if (!document.contains(t.el) || rawStyle(t.el) === t.origStyle) continue
      const { width, height } = t.el.style
      Object.assign(change(t.el, t.origStyle).style, {
        width: width || null,
        height: height || null,
      })
    }
    const layout = (
      el: HTMLElement,
      prefix: StructurePrefix,
      origStyle: string | null,
      was: Partial<Record<keyof typeof STRUCTURAL_LAYOUT, string | null>>,
    ) => {
      const keys = Object.keys(was) as (keyof typeof STRUCTURAL_LAYOUT)[]
      if (keys.every((key) => el.getAttribute(structureAttribute(prefix, key)) === was[key])) return
      const entry = change(el, origStyle)
      for (const key of keys) {
        entry.attrs[`data-derive-${key}`] = el.getAttribute(structureAttribute(prefix, key))
        const property = STRUCTURAL_LAYOUT[key]?.[0]
        if (property) entry.style[property] = el.style.getPropertyValue(property).trim() || null
      }
    }
    for (const region of structureRegions)
      for (const node of region.nodes)
        if (node.el.isConnected)
          layout(node.el, node.prefix, node.origStyle, {
            size: node.origSize,
            width: node.origWidth,
            height: node.origHeight,
          })
    for (const [el, { orig, style, attrs }] of changed) {
      const src = srcOf(el)
      if (src === null) uncaptured++
      else
        ops.push({
          op: "attrs",
          src,
          hash: "",
          style: updatedStyle(orig ?? "", style) || null,
          ...(Object.keys(attrs).length ? { attrs } : {}),
        })
    }
    const { deriveSrcVersion, deriveSrcSha } = document.documentElement.dataset
    return { ops, base: { version: Number(deriveSrcVersion), sha: deriveSrcSha ?? "" }, uncaptured }
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
        { fromSelection: !!d.fromSelection, select: d.select },
        !!d.elementEdits,
      )
    // The edit bar's controls, driven from the host. Same functions the keyboard
    // chords call, so a button and its shortcut can never mean different things.
    else if (d.type === "edit-undo") {
      if (!cancelStructuralGesture()) undo()
    } else if (d.type === "edit-redo") {
      if (!cancelStructuralGesture()) redo()
    } else if (d.type === "edit-format")
      applyFmt(
        d.kind === "i" ? "i" : d.kind === "a" ? "a" : "b",
        typeof d.href === "string" ? d.href : undefined,
      )
    else if (d.type === "edit-mention-insert") insertEditMention(String(d.handle || ""))
    else if (d.type === "edit-mention-close") clearEditMention()
    else if (d.type === "mention-render" && Array.isArray(d.handles)) {
      const handles: unknown[] = d.handles
      const resolved = new Set<string>(
        handles.filter(isMentionHandle).map((handle) => handle.toLowerCase()),
      )
      decorateMentions(resolved)
    }
    // Only sent to a SNIFFED deck: one that speaks the protocol is driven by its own
    // `deck` message, which it answers itself.
    else if (d.type === "deck-drive") driveDeck(String(d.action || ""), d.n)
    else if (d.type === "video-drive")
      driveVideo(String(d.action || ""), d.n, typeof d.id === "string" ? d.id : undefined)
    else if (d.type === "video-edit") {
      const op = String(d.op || "")
      const id = String(d.id || "")
      if (op === "update")
        applySceneFromHost({
          op: "scene-update",
          id,
          duration_ms: typeof d.durationMs === "number" ? d.durationMs : undefined,
          transition: typeof d.transition === "string" ? d.transition : undefined,
          transition_ms: typeof d.transitionMs === "number" ? d.transitionMs : undefined,
          caption: typeof d.caption === "string" ? d.caption : undefined,
        })
      else if (op === "move" && (d.direction === "previous" || d.direction === "next"))
        applySceneFromHost({ op: "scene-move", id, direction: d.direction })
      else if (op === "duplicate") applySceneFromHost({ op: "scene-duplicate", id })
      else if (op === "delete") applySceneFromHost({ op: "scene-delete", id })
    } else if (d.type === "edit-collect") {
      // The nonce rides back untouched: a slow page can answer a TIMED-OUT collect
      // after the host started a new one, and stale edits must not resolve it.
      if (srcSnap)
        post({
          type: "edit-edits",
          ...collectOps(srcSnap),
          dirty: countDirty(),
          nonce: d.nonce,
          // Where to pick up after the save reloads the page.
          resume: pathOf(blockSel),
        })
      else post({ type: "edit-edits", ...collectEdits(), nonce: d.nonce })
    } else if (d.type === "edit-restore") restoreEdits()
    // The host's changes list and its block panel.
    else if (d.type === "edit-reveal") revealChange(String(d.id))
    else if (d.type === "edit-revert") revertChange(String(d.id))
    else if (d.type === "edit-block-crumb") selectCrumb(Number(d.index))
    else if (d.type === "edit-block-width")
      setBlockSize(
        typeof d.width === "number" && Number.isFinite(d.width)
          ? Math.round(
              Math.min(MAX_STRUCTURAL_WIDTH_PCT, Math.max(MIN_STRUCTURAL_WIDTH_PCT, d.width)),
            )
          : null,
      )
    else if (d.type === "scroll-by") window.scrollBy(0, d.dy || 0)
    else if (d.type === "review-mode") setReviewMode(!!d.on)
    else if (d.type === "focus-review") {
      const target = typeof d.id === "string" ? document.getElementById(d.id) : null
      if (!target) return
      const rect = target.getBoundingClientRect()
      fastScrollTo(scrollTop() + rect.top - Math.max(16, (window.innerHeight - rect.height) / 2))
      target.classList.remove("derive-review-flash")
      void (target as HTMLElement).offsetWidth
      target.classList.add("derive-review-flash")
      window.setTimeout(() => target.classList.remove("derive-review-flash"), 2100)
      setTimeout(reportScroll, 260)
    } else if (d.type === "focus-anchor") {
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

  // Last on purpose: the document is fully parsed, our own overlay vocabulary is
  // established, and no edit mode is active yet. The host resolves only genuine,
  // eligible collaborators before asking us to wrap them, so ambient @handles do
  // not impersonate a Derive mention.
  post({ type: "mention-resolve", handles: mentionHandlesInDocument() })
})()
