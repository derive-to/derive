import type { Dispatch, SetStateAction } from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { Comment } from "@/api"
import { groupThreads } from "./lib/layout"
import { type AnchorConf, type FrameGeom, type Panel, parseAnchor, type Selection } from "./types"

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
  // Set when the artifact announces itself as a deck (derive-deck protocol).
  const [deck, setDeck] = useState<{ i: number; total: number } | null>(null)
  // The deck position read inside the message handler (a stable closure that never
  // re-subscribes), so selection-capture and cursor-tagging see the CURRENT slide
  // rather than the stale value `deck` would be frozen at. Kept in sync below.
  const deckRef = useRef<{ i: number; total: number } | null>(null)

  const post = useCallback((msg: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage({ source: "derive-host", ...msg }, "*")
  }, [])

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
        const next = { i: d.i ?? 0, total: d.total ?? 1 }
        deckRef.current = next
        setDeck(next)
        return
      }
      if (d.source !== "derive") return
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
        { source: "derive-host", type: "deck", action, n },
        "*",
      ),
    [],
  )
  const toggleFullscreen = () => {
    const el = presentWrap.current
    if (!el) return
    if (document.fullscreenElement) document.exitFullscreen()
    else el.requestFullscreen?.()
  }
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
  // Arrow keys drive the deck from the host (when not typing in a field).
  useEffect(() => {
    if (!deck) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return
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
    toggleFullscreen,
    sel,
    setSel,
    inDoc,
    landedSlides,
    anchorConf,
    anchorTops,
    subscribeGeom,
  }
}
