import type { Dispatch, SetStateAction } from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { Comment } from "@/api"
import { bareHotkey } from "@/lib/hotkey"
import { groupThreads } from "./lib/layout"
import {
  type AnchorConf,
  type Deck,
  type FrameGeom,
  type Panel,
  parseAnchor,
  type Selection,
} from "./types"
import { usePresentMode } from "./use-present-mode"

/** Host URL deep link for decks: `#s3` / `#3` / `?slide=3` (1-based). Returns NaN when absent. */
export const deepSlideFrom = (hash: string, search: string): number => {
  const fromHash = String(hash || "").match(/^#(?:s)?(\d+)$/i)
  if (fromHash) return Number.parseInt(fromHash[1] as string, 10)
  try {
    const n = Number.parseInt(
      new URLSearchParams(String(search || "").replace(/^\?/, "")).get("slide") || "",
      10,
    )
    return Number.isFinite(n) ? n : Number.NaN
  } catch {
    return Number.NaN
  }
}

/** Keep the SPA hash on `#sN` so a copied URL opens the same slide. */
const writeDeckHash = (i: number) => {
  try {
    const next = `#s${i + 1}`
    if (window.location.hash === next) return
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}${next}`)
  } catch {
    /* private mode / sandboxed history */
  }
}

// Keep `anchorTops` referentially stable when the tops are unchanged, so a re-post doesn't
// churn the comment layout. The frame already dedupes anchor-rects on tops before sending
// (geometry rides its own `scroll` message now), so this is belt-and-suspenders.
const sameTops = (a: Record<string, number>, b: Record<string, number>): boolean => {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) if (a[k] !== b[k]) return false
  return true
}

/**
 * The entire conversation with the sandboxed artifact iframe, kept out of the
 * page. The frame is a separate opaque origin, so everything crosses via
 * postMessage: it reports text selections, anchor geometry, scroll, hover/click
 * on highlights, deck position, and pointer moves; we send it highlight anchors
 * and deck/emphasis commands. This hook owns the frame ref, the inbound message
 * router, the doc geometry those messages carry (selection + anchor tops +
 * scroll), and the deck controls. The page reads `sel`/`inDoc`/`anchorTops`/
 * `scrollY` back out to lay out the comment pins and uses `post` to drive
 * emphasis/focus. The three setters it pokes are the page's stable useState
 * dispatchers, so the message listener subscribes once.
 */
export function useArtifactFrame(p: {
  comments: Comment[]
  shortId: string
  version: number | undefined
  hoverThread: string | null
  /** The selected/expanded thread — kept emphasized in the doc even without
   *  the mouse over its card, so picking a comment (click, or Prev/Next) reads
   *  as a persistent selection, not a hover trick you have to hold. */
  activeThread: string | null
  onPointerMove: (x: number, y: number, slide?: number) => void
  onPointerLeave: () => void
  onTap: (x: number, y: number, slide?: number) => void
  setHoverThread: Dispatch<SetStateAction<string | null>>
  setActiveThread: Dispatch<SetStateAction<string | null>>
  setPanel: Dispatch<SetStateAction<Panel>>
  // A cross-document link inside the frame was clicked: the server resolved it to a
  // sibling artifact `ref`. The frame is sandboxed and can't navigate the host, so it
  // hands the click here for an SPA transition (or a new tab on a modified click).
  onNavigate: (ref: string, newTab: boolean) => void
  /** Escape pressed while keyboard focus was inside the frame — the client
   *  forwards it because the host's window listener can't see in. Treat it like
   *  a window Escape (exit focus mode, cancel a composer). */
  onEsc?: () => void
  /** A non-bundle link clicked in the frame (absolute URL). The frame never
   *  navigates itself — the host SPA-routes the app's own /artifacts/… URLs and
   *  opens anything else in a clean un-sandboxed tab. The href comes from
   *  untrusted artifact HTML: validate the scheme before acting. */
  onOpenExternal?: (href: string) => void
  /** Is inline edit mode open? A GETTER, not a flag: this hook runs before the edit
   *  hook exists, so the page hands it a live read instead of a value. The host's
   *  own arrow keys stop driving the deck while it's true — the two share a
   *  keyboard, and someone editing a slide reaches for the arrows to move a caret,
   *  not to leave the slide they're working on. (Keys typed with the caret in the
   *  document never reach the host at all; the frame owns those. This is the other
   *  half: focus sitting on the host's chrome mid-session.) */
  isEditing?: () => boolean
  /** Present mode is opening: the page closes an edit session and parks anything
   *  modal, because a deck being typed into is not a deck being presented. Return
   *  false to refuse (unsaved edits — the confirm belongs on the page, not in
   *  front of a room). */
  onPresent?: () => boolean
}) {
  const {
    comments,
    shortId,
    version,
    hoverThread,
    activeThread,
    onPointerMove,
    onPointerLeave,
    onTap,
  } = p
  const { setHoverThread, setActiveThread, setPanel, onNavigate, onEsc, onOpenExternal } = p
  const frame = useRef<HTMLIFrameElement>(null)
  const presentWrap = useRef<HTMLDivElement>(null)
  const [frameReady, setFrameReady] = useState(0)
  const [sel, setSel] = useState<Selection>(null)
  const [inDoc, setInDoc] = useState<Record<string, boolean>>({})
  // Per-thread: the slide its anchor actually resolved on (null = not in any slide,
  // or non-deck). The frame reports this so a comment pins on the slide its text
  // really lives on — even after a republish moved the text to a different slide.
  const [landedSlides, setLandedSlides] = useState<Record<string, number | null>>({})
  // Per-thread element-anchor resolution quality (band + confidence), reported by
  // the frame so a card can show a quiet "moved" marker on an uncertain relocation.
  const [anchorConf, setAnchorConf] = useState<AnchorConf>({})
  const [anchorTops, setAnchorTops] = useState<Record<string, number>>({})
  // The frame's scroll offset + document/visible height. NOT React state: it changes
  // per scroll frame, and nothing should re-render on scroll — the pin layer, the
  // selection pill, and the cursor layer all consume it imperatively through
  // `subscribeGeom` (immediate call with the current value; returns unsubscribe).
  const geomRef = useRef<FrameGeom>({ scrollY: 0, docH: 0, viewH: 0 })
  const geomSubs = useRef(new Set<(g: FrameGeom) => void>())
  const updateGeom = useCallback((g: Partial<FrameGeom>) => {
    const cur = geomRef.current
    const next: FrameGeom = {
      scrollY: typeof g.scrollY === "number" ? g.scrollY : cur.scrollY,
      docH: typeof g.docH === "number" ? g.docH : cur.docH,
      viewH: typeof g.viewH === "number" ? g.viewH : cur.viewH,
    }
    if (next.scrollY === cur.scrollY && next.docH === cur.docH && next.viewH === cur.viewH) return
    geomRef.current = next
    for (const cb of geomSubs.current) cb(next)
  }, [])
  const subscribeGeom = useCallback((cb: (g: FrameGeom) => void) => {
    geomSubs.current.add(cb)
    cb(geomRef.current)
    return () => {
      geomSubs.current.delete(cb)
    }
  }, [])
  // Set when the artifact announces itself as a deck (derive-deck protocol), or when
  // the injected client sniffed one out of the markup. `sniffed` decides who gets
  // driven: a deck that speaks the protocol answers `deck` itself; a sniffed one is
  // moved by the client on its behalf.
  const [deck, setDeck] = useState<Deck | null>(null)
  // The deck position read inside the message handler (a stable closure that never
  // re-subscribes), so selection-capture and cursor-tagging see the CURRENT slide
  // rather than the stale value `deck` would be frozen at. Kept in sync below.
  const deckRef = useRef<Deck | null>(null)

  const post = useCallback((msg: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage({ source: "derive-host", ...msg }, "*")
  }, [])
  // Present mode is set up below (it needs the deck), but the message listener above
  // is registered once and must reach the CURRENT toggle — hence a ref, the same
  // pattern the page uses for the inline-edit API.
  const presentRef = useRef<() => void>(() => {})

  // Scroll the document by a pixel delta. The comments aside calls this to forward
  // wheel gestures over the panel into the doc, so scrolling there moves the page
  // and the pinned cards glide along with their highlights (Google-Docs feel).
  const scrollBy = useCallback((dy: number) => post({ type: "scroll-by", dy }), [post])

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      // Only the artifact iframe's own window speaks this protocol. Without the
      // source pin, ANY window that can post here — a nested iframe inside the
      // artifact, a popup, the source editor's preview iframe (whose rendered
      // markdown also carries the client script) — could inject selects, navigates,
      // and deck state into the workbench.
      if (!frame.current?.contentWindow || e.source !== frame.current.contentWindow) return
      const d = e.data
      if (!d) return
      // A slide deck reporting its position (any HTML that speaks the protocol).
      if (d.source === "derive-deck" && d.type === "state") {
        const next = { i: d.i ?? 0, total: d.total ?? 1, sniffed: false }
        deckRef.current = next
        setDeck(next)
        // Keep the SPA address bar in step with the deck so a shared URL lands on
        // the same slide (template deep links alone only see the iframe's empty hash).
        writeDeckHash(next.i)
        return
      }
      if (d.source !== "derive") return
      // The injected client recognised a deck the artifact never announced. An
      // artifact that speaks for itself always wins: once a protocol message has
      // arrived, the sniff is ignored for the life of this document, so a deck can
      // never be half-driven by both paths.
      if (d.type === "deck-sniff") {
        if (deckRef.current && !deckRef.current.sniffed) return
        const next = { i: d.i ?? 0, total: d.total ?? 1, sniffed: true }
        deckRef.current = next
        setDeck(next)
        writeDeckHash(next.i)
        return
      }
      if (d.type === "select") {
        if (d.selector && d.rect) {
          const fr = frame.current?.getBoundingClientRect()
          const ft = fr?.top ?? 0
          const fl = fr?.left ?? 0
          // On a deck, stamp the current slide onto the anchor so the comment is
          // pinned to the slide it was made on. Captured here at selection time.
          const cur = deckRef.current
          const selector = cur ? { ...d.selector, slide: cur.i } : d.selector
          setSel({
            selector,
            top: d.rect.top,
            // Doc-absolute Y, stamped at receive: the frame posts the rect in ITS
            // viewport coords, so add its current scroll. This is what keeps the
            // composer/pill attached to the selection when the doc scrolls later
            // (a frozen viewport Y was the old "composer parks mid-scroll" bug).
            // Worst case it's one rAF-throttled scroll message stale.
            docTop: d.rect.top + geomRef.current.scrollY,
            vTop: ft + d.rect.top,
            vBottom: ft + d.rect.bottom,
            // left/right are sent by the current anchor client; guard against a
            // stale-cached client posting only top/bottom so we never get NaN.
            vLeft: fl + (d.rect.left ?? 0),
            vRight: fl + (d.rect.right ?? d.rect.left ?? 0),
          })
        } else setSel(null)
      } else if (d.type === "anchors-resolved") {
        setInDoc(d.resolved ?? {})
        // Older clients omit `slides`; default to empty so the page falls back to
        // each comment's recorded slide.
        setLandedSlides(d.slides ?? {})
        // Element anchors report per-thread resolution quality (band/confidence) so
        // a card can flag a relocation; text/older clients omit it.
        setAnchorConf(d.conf ?? {})
      } else if (d.type === "anchor-rects") {
        const tops: Record<string, number> = d.tops ?? {}
        setAnchorTops((prev) => (sameTops(prev, tops) ? prev : tops))
      } else if (d.type === "scroll") {
        updateGeom(d)
      } else if (d.type === "anchor-hover") setHoverThread(d.id ?? null)
      else if (d.type === "anchor-click") {
        setActiveThread(d.id)
        setPanel((cur) => (cur === "open" ? cur : "open"))
      } else if (d.type === "cursor" && typeof d.x === "number" && typeof d.y === "number") {
        onPointerMove(d.x, d.y, deckRef.current?.i)
      } else if (d.type === "cursor-tap" && typeof d.x === "number" && typeof d.y === "number") {
        onTap(d.x, d.y, deckRef.current?.i)
      } else if (d.type === "cursor-leave") {
        onPointerLeave()
      } else if (d.type === "present") {
        // `p` pressed with focus inside the document. Only a deck can be presented,
        // and only from a read state — mid-edit the mode has its own answer.
        if (deckRef.current) presentRef.current()
      } else if (d.type === "navigate" && typeof d.ref === "string") {
        onNavigate(d.ref, !!d.newTab)
      } else if (d.type === "open-external" && typeof d.href === "string") {
        onOpenExternal?.(d.href)
      } else if (d.type === "esc") {
        onEsc?.()
      }
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [
    onPointerMove,
    onPointerLeave,
    onTap,
    setHoverThread,
    setActiveThread,
    setPanel,
    onNavigate,
    onEsc,
    onOpenExternal,
    updateGeom,
  ])

  // Two-way hover: emphasize the matching highlight in the doc when a comment
  // card is hovered (the inbound anchor-hover sets the same state the other way).
  // Hover wins while it's happening; otherwise the SELECTED thread stays
  // emphasized, so picking a comment (click, Prev/Next) keeps its highlight lit
  // in the doc instead of a hover-only flash you lose the moment the mouse moves.
  useEffect(() => {
    post({ type: "emphasize", id: hoverThread ?? activeThread })
  }, [hoverThread, activeThread, post])

  // Drive the deck from the host bar; fullscreen wraps the iframe + bar so the
  // controls stay reachable while presenting.
  const deckCmd = useCallback(
    (action: "next" | "prev" | "goto", n?: number) =>
      frame.current?.contentWindow?.postMessage(
        // A protocol deck moves itself; a sniffed one is moved by the injected
        // client (which synthesizes the key the page already listens for, so the
        // page's own idea of where it is stays true).
        {
          source: "derive-host",
          type: deckRef.current?.sniffed ? "deck-drive" : "deck",
          action,
          n,
        },
        "*",
      ),
    [],
  )

  // On first announce, honour a host deep link the iframe couldn't see
  // (`#s3` / `#3` / `?slide=3` on the SPA URL). Only once per document load —
  // later state messages already reflect navigation the user made.
  const deepApplied = useRef(false)
  useEffect(() => {
    if (!deck || deepApplied.current) return
    deepApplied.current = true
    const deep = deepSlideFrom(window.location.hash, window.location.search)
    if (deep > 0 && deep - 1 !== deck.i) deckCmd("goto", deep - 1)
  }, [deck, deckCmd])
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the deep-link latch when the document changes.
  useEffect(() => {
    deepApplied.current = false
  }, [shortId, version])
  // Present mode owns the fullscreen element, the presenting state and the keyboard
  // that drives a deck while it's up (see use-present-mode). It lives here because
  // this hook already owns the wrapper and the drive command.
  const present = usePresentMode({
    wrapRef: presentWrap,
    hasDeck: !!deck,
    total: deck?.total ?? 1,
    cmd: deckCmd,
    onEnter: p.onPresent,
  })
  presentRef.current = present.toggle
  // Reset the per-document iframe state when the artifact/version changes — the
  // deck re-announces on load and a stale selection shouldn't carry over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed to the artifact/version change, not to anything the callbacks read.
  useEffect(() => {
    setDeck(null)
    deckRef.current = null
    setSel(null)
    setLandedSlides({})
    setAnchorConf({})
  }, [shortId, version])
  // A slide flip toggles element visibility without a scroll or resize, so the
  // frame won't re-measure on its own — ping it to re-report highlight rects so the
  // now-visible slide's pins land at the right Y.
  useEffect(() => {
    if (deck) post({ type: "remeasure" })
  }, [deck, post])
  // Arrow keys drive the deck from the host. Off while inline editing, and gated by
  // the shared bare-hotkey rule — the hand-rolled INPUT/TEXTAREA test this used to
  // carry missed contentEditable surfaces (the comment composer, the source editor)
  // and open dialogs, so typing a reply moved the slide behind it.
  const isEditingRef = useRef<() => boolean>(() => false)
  isEditingRef.current = p.isEditing ?? (() => false)
  const presentingRef = useRef(false)
  presentingRef.current = present.presenting
  useEffect(() => {
    if (!deck) return
    const onKey = (e: KeyboardEvent) => {
      // While presenting, the present-mode listener owns the whole deck keyboard
      // (it handles Space, PageUp/PageDown and Home/End too) — running both would
      // advance two slides per press.
      if (!bareHotkey(e) || isEditingRef.current() || presentingRef.current) return
      if (e.key === "ArrowRight") deckCmd("next")
      else if (e.key === "ArrowLeft") deckCmd("prev")
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [deck, deckCmd])

  // Paint highlights for active (open or addressed), anchored threads whenever
  // the doc or comments change. RESOLVED threads ride along as `quiet` anchors:
  // resolved in the doc (so "jump to context" works from their cards, with a
  // one-time flash) but never painted, hover-lit, or pinned. Outdated threads
  // stay out — their anchor is known-stale.
  const sendAnchors = useCallback(() => {
    const w = frame.current?.contentWindow
    if (!w) return
    const anchors = groupThreads(comments)
      .map((t) => t[0])
      .filter(
        (head): head is Comment =>
          head?.state === "open" || head?.state === "addressed" || head?.state === "resolved",
      )
      .flatMap((head) => {
        const sel = parseAnchor(head.anchor)
        if (!sel) return []
        const id = head.thread_id
        const quiet = head.state === "resolved" ? true : undefined
        // Element anchor: hand the client the whole selector to relocate via the
        // cascade. Text anchor: the quote + context it greps for.
        return [
          sel.element
            ? { id, quiet, el: sel.element }
            : {
                id,
                quiet,
                exact: sel.exact,
                prefix: sel.prefix,
                suffix: sel.suffix,
                // The frame scopes resolution to this slide first (deck artifacts only).
                slide: sel.slide,
              },
        ]
      })
    w.postMessage({ source: "derive-host", type: "anchors", anchors }, "*")
  }, [comments])
  // biome-ignore lint/correctness/useExhaustiveDependencies: frameReady is an intentional repaint trigger (re-send anchors when the iframe reloads).
  useEffect(() => {
    sendAnchors()
  }, [sendAnchors, frameReady])

  return {
    frame,
    presentWrap,
    // The iframe (re)loaded. That's not only a shortId/version change: a live
    // version auto-swap and a RenderStage retry also reload the frame with the
    // SAME key — so the fresh document starts at
    // scrollY 0 and the OLD doc's anchor tops are meaningless. Reset both here
    // (pins go unlocated/invisible until the new doc reports) instead of pinning
    // stale cards over the new document.
    onFrameLoad: () => {
      updateGeom({ scrollY: 0, docH: 0, viewH: 0 })
      setAnchorTops({})
      setFrameReady((n) => n + 1)
    },
    post,
    scrollBy,
    deck,
    deckCmd,
    present,
    sel,
    setSel,
    inDoc,
    landedSlides,
    anchorConf,
    anchorTops,
    subscribeGeom,
  }
}
