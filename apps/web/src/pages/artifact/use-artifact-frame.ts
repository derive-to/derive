import type { Dispatch, SetStateAction } from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { Comment } from "@/api"
import { groupThreads } from "./lib/layout"
import { type AnchorConf, type Panel, parseAnchor, type Selection } from "./types"

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
}) {
  const { comments, shortId, version, hoverThread, onPointerMove, onPointerLeave, onTap } = p
  const { setHoverThread, setActiveThread, setPanel, onNavigate } = p
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
  const [scrollY, setScrollY] = useState(0)
  // The frame's own document height + visible height, reported alongside scroll.
  // The live-cursor layer needs both to map a peer's document position to a screen
  // position in this viewport (and decide who's scrolled off-screen).
  const [docH, setDocH] = useState(0)
  const [viewH, setViewH] = useState(0)
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
        setAnchorTops(d.tops ?? {})
        if (typeof d.scrollY === "number") setScrollY(d.scrollY)
        if (typeof d.docH === "number") setDocH(d.docH)
        if (typeof d.viewH === "number") setViewH(d.viewH)
      } else if (d.type === "scroll") {
        if (typeof d.scrollY === "number") setScrollY(d.scrollY)
        if (typeof d.docH === "number") setDocH(d.docH)
        if (typeof d.viewH === "number") setViewH(d.viewH)
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
      }
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [onPointerMove, onPointerLeave, onTap, setHoverThread, setActiveThread, setPanel, onNavigate])

  // Two-way hover: emphasize the matching highlight in the doc when a comment
  // card is hovered (the inbound anchor-hover sets the same state the other way).
  useEffect(() => {
    post({ type: "emphasize", id: hoverThread })
  }, [hoverThread, post])

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
  // the doc or comments change. Resolved/outdated threads don't paint.
  const sendAnchors = useCallback(() => {
    const w = frame.current?.contentWindow
    if (!w) return
    const anchors = groupThreads(comments)
      .map((t) => t[0])
      .filter((head): head is Comment => head?.state === "open" || head?.state === "addressed")
      .map((head) => ({
        id: head.thread_id,
        sel: parseAnchor(head.anchor),
      }))
      .filter((x): x is { id: string; sel: NonNullable<ReturnType<typeof parseAnchor>> } => !!x.sel)
      .map((x) =>
        // Element anchor: hand the client the whole selector to relocate via the
        // cascade. Text anchor: the quote + context it greps for.
        x.sel.element
          ? { id: x.id, el: x.sel.element }
          : {
              id: x.id,
              exact: x.sel.exact,
              prefix: x.sel.prefix,
              suffix: x.sel.suffix,
              // The frame scopes resolution to this slide first (deck artifacts only).
              slide: x.sel.slide,
            },
      )
    w.postMessage({ source: "derive-host", type: "anchors", anchors }, "*")
  }, [comments])
  // biome-ignore lint/correctness/useExhaustiveDependencies: frameReady is an intentional repaint trigger (re-send anchors when the iframe reloads).
  useEffect(() => {
    sendAnchors()
  }, [sendAnchors, frameReady])

  return {
    frame,
    presentWrap,
    onFrameLoad: () => setFrameReady((n) => n + 1),
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
    scrollY,
    docH,
    viewH,
  }
}
