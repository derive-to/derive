import type { Dispatch, SetStateAction } from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { Comment } from "@/api"
import { groupThreads, parseAnchor } from "./lib/layout"
import type { Panel, Sel } from "./types"

type Selection = {
  selector: Sel
  top: number
  vTop: number
  vBottom: number
  vLeft: number
  vRight: number
} | null

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
  onPointerMove: (x: number, y: number) => void
  onPointerLeave: () => void
  onTap: (x: number, y: number) => void
  setHoverThread: Dispatch<SetStateAction<string | null>>
  setActiveThread: Dispatch<SetStateAction<string | null>>
  setPanel: Dispatch<SetStateAction<Panel>>
}) {
  const { comments, shortId, version, hoverThread, onPointerMove, onPointerLeave, onTap } = p
  const { setHoverThread, setActiveThread, setPanel } = p
  const frame = useRef<HTMLIFrameElement>(null)
  const presentWrap = useRef<HTMLDivElement>(null)
  const [frameReady, setFrameReady] = useState(0)
  const [sel, setSel] = useState<Selection>(null)
  const [inDoc, setInDoc] = useState<Record<string, boolean>>({})
  const [anchorTops, setAnchorTops] = useState<Record<string, number>>({})
  const [scrollY, setScrollY] = useState(0)
  // Set when the artifact announces itself as a deck (dock-deck protocol).
  const [deck, setDeck] = useState<{ i: number; total: number } | null>(null)

  const post = useCallback((msg: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage({ source: "dock-host", ...msg }, "*")
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
      if (d.source === "dock-deck" && d.type === "state") {
        setDeck({ i: d.i ?? 0, total: d.total ?? 1 })
        return
      }
      if (d.source !== "dock") return
      if (d.type === "select") {
        if (d.selector && d.rect) {
          const fr = frame.current?.getBoundingClientRect()
          const ft = fr?.top ?? 0
          const fl = fr?.left ?? 0
          setSel({
            selector: d.selector,
            top: d.rect.top,
            vTop: ft + d.rect.top,
            vBottom: ft + d.rect.bottom,
            // left/right are sent by the current anchor client; guard against a
            // stale-cached client posting only top/bottom so we never get NaN.
            vLeft: fl + (d.rect.left ?? 0),
            vRight: fl + (d.rect.right ?? d.rect.left ?? 0),
          })
        } else setSel(null)
      } else if (d.type === "anchors-resolved") setInDoc(d.resolved ?? {})
      else if (d.type === "anchor-rects") {
        setAnchorTops(d.tops ?? {})
        if (typeof d.scrollY === "number") setScrollY(d.scrollY)
      } else if (d.type === "scroll") {
        if (typeof d.scrollY === "number") setScrollY(d.scrollY)
      } else if (d.type === "anchor-hover") setHoverThread(d.id ?? null)
      else if (d.type === "anchor-click") {
        setActiveThread(d.id)
        setPanel((cur) => (cur === "open" ? cur : "open"))
      } else if (d.type === "cursor" && typeof d.x === "number" && typeof d.y === "number") {
        onPointerMove(d.x, d.y)
      } else if (d.type === "cursor-tap" && typeof d.x === "number" && typeof d.y === "number") {
        onTap(d.x, d.y)
      } else if (d.type === "cursor-leave") {
        onPointerLeave()
      }
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [onPointerMove, onPointerLeave, onTap, setHoverThread, setActiveThread, setPanel])

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
        { source: "dock-host", type: "deck", action, n },
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
    setSel(null)
  }, [shortId, version])
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

  // Paint highlights for open, anchored threads whenever the doc or comments change.
  const sendAnchors = useCallback(() => {
    const w = frame.current?.contentWindow
    if (!w) return
    const anchors = groupThreads(comments)
      .map((t) => t[0])
      .filter((head): head is Comment => head?.state === "open")
      .map((head) => ({ id: head.thread_id, sel: parseAnchor(head.anchor) }))
      .filter((x): x is { id: string; sel: NonNullable<ReturnType<typeof parseAnchor>> } => !!x.sel)
      .map((x) => ({ id: x.id, exact: x.sel.exact, prefix: x.sel.prefix, suffix: x.sel.suffix }))
    w.postMessage({ source: "dock-host", type: "anchors", anchors }, "*")
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
    anchorTops,
    scrollY,
  }
}
