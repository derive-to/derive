import { useCallback, useEffect, useRef, useState } from "react"
import { useCursorPref } from "@/ctx"
import {
  CURSOR_FALLBACK,
  CURSOR_TUNING,
  type CursorFrame,
  effectiveDocH,
  placePeer,
} from "@/lib/cursors"

// The RECEIVING half of the live-cursor engine: it takes peer frames off the SSE
// stream and paints them as a single rAF-driven overlay that eases (lerps) toward each
// peer's latest position, so cursors glide instead of teleporting between throttled
// samples; the name tag fades after a beat of stillness, and peers scrolled past a
// viewport edge collapse into an edge indicator. React only re-renders when the roster
// changes (a peer joins, leaves, or restyles) or a ripple fires; every-frame motion is
// written straight to the DOM via refs, never through React. The SENDING half (our own
// pointer → server) lives in use-cursor-send. `selfId` is shared so we ignore our own
// echoed frames.

// Drop a peer's tracked scroll position after this much silence (they've gone). Generous —
// a followed peer who pauses reading shouldn't be forgotten; leaving presence stops follow.
const VIEWPORT_TTL_MS = 60_000

/** A peer entry the overlay mounts/unmounts and styles (no per-frame churn). */
export interface PeerView {
  id: string
  color: string
  kind: "arrow" | "emoji"
  emoji?: string
  name: string
}

/** A one-shot click ripple, positioned in SCREEN px (already mapped through the tapper's
 *  document position + our scroll at paint time — so it lands on the tapped content). */
export interface Ripple {
  key: number
  x: number
  y: number
  color: string
}

/** What the overlay needs to render + animate the layer. */
export interface CursorLayerHandle {
  ref: React.RefObject<HTMLDivElement | null>
  roster: PeerView[]
  ripples: Ripple[]
  register: (id: string, el: HTMLElement | null) => void
  /** Peers whose document position is above / below the visible viewport, shown
   *  as edge indicators instead of a cursor pinned at the edge. */
  above: PeerView[]
  below: PeerView[]
  /** The peer we're following, for the "Following …" banner (null if none). */
  followingPeer: PeerView | null
  /** Stop following — the banner's button (auto-exit on manual scroll shares it). */
  onStopFollow: () => void
}

/** Per-peer animation state — lives in a ref, mutated outside React. */
interface PeerTarget {
  x: number // latest document-normalized target (0..1): x by width, y by doc height
  y: number
  cx: number // current eased position: cx in layer px (x), cy in document px (y)
  cy: number
  color: string
  kind: "arrow" | "emoji"
  emoji?: string
  name: string
  slide?: number // deck slide the peer is on (undefined on non-deck artifacts)
  gone: boolean
  fade: number // opacity while leaving (1 → 0)
  lastSeen: number
  lastMoveAt: number
  el: HTMLElement | null
  labelEl: HTMLElement | null
}

const styleChanged = (t: PeerTarget, f: CursorFrame) =>
  t.color !== (f.color ?? t.color) ||
  t.kind !== (f.kind ?? t.kind) ||
  t.emoji !== f.emoji ||
  t.name !== (f.name ?? t.name)

export function useCursorPaint(selfId: string): {
  paintFrame: (f: CursorFrame) => void
  setGeom: (g: { scrollY: number; docH: number; viewH: number }) => void
  setViewSlide: (slide: number | null) => void
  /** Follow controls: lock our scroll to a peer's (see the follow block above). */
  following: string | null
  followingPeer: PeerView | null
  follow: (id: string, name: string) => void
  unfollow: () => void
  /** Injected by the page: how to command the artifact frame to scroll to a fraction. */
  setFollowScroll: (fn: ((frac: number) => void) | null) => void
  layer: CursorLayerHandle
} {
  const { pref } = useCursorPref()
  // Read the latest pref without re-binding the paint callbacks.
  const prefRef = useRef(pref)
  prefRef.current = pref

  // This viewer's own live iframe geometry (scroll offset + document/visible
  // height), fed in from the frame bridge. Peers are stored as document-normalized
  // positions and mapped against THIS every frame, so a peer sits where they are
  // in the document and glides as we scroll. A ref so the rAF loop reads it without
  // re-subscribing.
  const geomRef = useRef({ scrollY: 0, docH: 0, viewH: 0 })
  const setGeom = useCallback((g: { scrollY: number; docH: number; viewH: number }) => {
    geomRef.current = g
  }, [])

  // When the viewer prefers reduced motion, peers snap to position (no glide) and
  // click ripples are suppressed. A ref (synced below) so the rAF loop + paintFrame
  // can read it every frame without re-subscribing. SSR-safe: false until mounted.
  const reducedMotion = useRef(
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  )
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    const sync = () => {
      reducedMotion.current = mq.matches
    }
    sync()
    mq.addEventListener("change", sync)
    return () => mq.removeEventListener("change", sync)
  }, [])

  const layerRef = useRef<HTMLDivElement>(null)

  // The slide we're VIEWING (peers on a different slide are hidden). null/undefined on
  // a non-deck artifact, so nothing is filtered. (The slide we're ON is tagged onto
  // outgoing frames by the send half.)
  const viewSlide = useRef<number | null>(null)
  const setViewSlide = useCallback((s: number | null) => {
    viewSlide.current = s
    // Fade any peer we're showing who isn't on our new slide (instant, not on TTL).
    if (s == null) return
    for (const t of targets.current.values()) if (t.slide != null && t.slide !== s) t.gone = true
  }, [])

  // Peer animation state (ref) + the React-visible roster/ripples (state).
  const targets = useRef(new Map<string, PeerTarget>())
  // Each peer's latest scroll fraction — kept SEPARATE from their cursor target because
  // viewport ≠ pointer: a peer scrolling with the mouse off the doc has no live cursor but
  // still updates this, so "follow" tracks them. `t` is the last-heard time for TTL pruning.
  const viewports = useRef(new Map<string, { sf: number; t: number }>())
  const [roster, setRoster] = useState<PeerView[]>([])
  const [ripples, setRipples] = useState<Ripple[]>([])
  const rosterDirty = useRef(false)
  // Peers scrolled above / below this viewport, surfaced as edge indicators
  // (Miro/Figma style). Computed in the rAF loop, pushed to React only when the
  // membership actually changes (never every frame).
  const [offscreen, setOffscreen] = useState<{ above: PeerView[]; below: PeerView[] }>({
    above: [],
    below: [],
  })
  const offscreenKey = useRef("")
  const rippleKey = useRef(0)

  // "Follow" a peer: glue our own scroll to theirs, so we see exactly what they're
  // pointing at wherever they are in the doc (Figma/tldraw follow). We read their scroll
  // from `viewports` (updated by any frame, cursor or bare scroll); the rAF loop pushes it
  // to `onFollowScroll`, which index wires to a scroll command in the artifact frame. Keyed
  // by the peer's stable presence id (cursor id === presence id — see use-live-cursors), so
  // the facepile can start it. `followingPeer` is carried explicitly (not derived from the
  // cursor roster) so the banner shows the instant you click Follow, before their 1st frame.
  const [following, setFollowing] = useState<string | null>(null)
  const [followingPeer, setFollowingPeer] = useState<PeerView | null>(null)
  const followingRef = useRef<string | null>(null)
  followingRef.current = following
  const onFollowScroll = useRef<((frac: number) => void) | null>(null)
  const lastFollowSf = useRef(-1)
  const follow = useCallback((id: string, name: string) => {
    lastFollowSf.current = -1 // force an immediate jump to the peer on the next frame
    // Tint the banner with their cursor color if we've seen their cursor; else neutral.
    const color = targets.current.get(id)?.color ?? CURSOR_FALLBACK
    setFollowing(id)
    setFollowingPeer({ id, color, kind: "arrow", name })
  }, [])
  const unfollow = useCallback(() => {
    setFollowing(null)
    setFollowingPeer(null)
  }, [])
  const setFollowScroll = useCallback((fn: ((frac: number) => void) | null) => {
    onFollowScroll.current = fn
  }, [])

  // Rebuild the roster from the targets map, coalesced to ≤1 render per burst.
  const markRosterDirty = useCallback(() => {
    if (rosterDirty.current) return
    rosterDirty.current = true
    queueMicrotask(() => {
      rosterDirty.current = false
      setRoster(
        [...targets.current.entries()].map(([id, t]) => ({
          id,
          color: t.color,
          kind: t.kind,
          emoji: t.emoji,
          name: t.name,
        })),
      )
    })
  }, [])

  const register = useCallback((id: string, el: HTMLElement | null) => {
    const t = targets.current.get(id)
    if (!t) return
    t.el = el
    t.labelEl = el?.querySelector<HTMLElement>("[data-cursor-label]") ?? null
  }, [])

  // Incoming peer frame (fed from the shared SSE stream in use-artifact-live).
  const paintFrame = useCallback(
    (f: CursorFrame) => {
      if (!f?.id || f.id === selfId) return
      // Viewer opted out of the cursor layer — ignore every incoming peer.
      if (prefRef.current.hidden) return
      // Deck: only show peers on the slide we're viewing. A peer who navigated away
      // fades out; a non-deck frame (slide undefined) is never filtered.
      const vs = viewSlide.current
      if (vs != null && f.slide != null && f.slide !== vs) {
        const ex = targets.current.get(f.id)
        if (ex) ex.gone = true
        return
      }

      const now = Date.now()
      // Viewport: record the peer's scroll fraction from ANY frame (a pointer move OR a bare
      // scroll), independent of the cursor lifecycle — this is what "follow" reads.
      if (typeof f.sf === "number") viewports.current.set(f.id, { sf: f.sf, t: now })
      // A scroll with the pointer off the doc (live === false) carries viewport state only
      // (recorded above); there's no pointer to render, so leave the cursor untouched.
      if (f.live === false) return

      if (f.tap && !reducedMotion.current) {
        // Ripples share the cursor's document space — map through our scroll so a tap deep in
        // a scrolled doc lands where it happened, not at a raw viewport fraction.
        const r = layerRef.current?.getBoundingClientRect()
        const docH = effectiveDocH(geomRef.current.docH, r?.height ?? 0)
        const place = placePeer(f.x * (r?.width ?? 0), f.y * docH, {
          scrollY: geomRef.current.scrollY || 0,
          docH,
          viewH: r?.height ?? 0,
        })
        if (place.onScreen) {
          const key = ++rippleKey.current
          setRipples((rs) => [
            ...rs,
            { key, x: place.x, y: place.y, color: f.color ?? CURSOR_FALLBACK },
          ])
          setTimeout(
            () => setRipples((rs) => rs.filter((r) => r.key !== key)),
            CURSOR_TUNING.rippleMs,
          )
        }
      }

      const existing = targets.current.get(f.id)
      if (f.gone) {
        if (existing) existing.gone = true // the rAF loop fades it out, then prunes
        return
      }
      if (!existing) {
        // New peer: seed the eased position at the target so it appears in place.
        // y is document-normalized, so seed cy in document pixels (eased there).
        const r = layerRef.current?.getBoundingClientRect()
        const docH = effectiveDocH(geomRef.current.docH, r?.height ?? 0)
        targets.current.set(f.id, {
          x: f.x,
          y: f.y,
          cx: f.x * (r?.width ?? 0),
          cy: f.y * docH,
          color: f.color ?? CURSOR_FALLBACK,
          kind: f.kind ?? "arrow",
          emoji: f.emoji,
          name: f.name ?? "Guest",
          slide: f.slide,
          gone: false,
          fade: 1,
          lastSeen: now,
          lastMoveAt: now,
          el: null,
          labelEl: null,
        })
        markRosterDirty()
        return
      }

      if (styleChanged(existing, f)) markRosterDirty()
      existing.x = f.x
      existing.y = f.y
      existing.color = f.color ?? existing.color
      existing.kind = f.kind ?? existing.kind
      existing.emoji = f.emoji
      existing.name = f.name ?? existing.name
      existing.slide = f.slide
      existing.gone = false
      existing.fade = 1
      existing.lastSeen = now
    },
    [markRosterDirty, selfId],
  )

  // Hiding opts the viewer out of the whole layer: drop everyone else's cursor (and,
  // via the guards above, stop painting until it's turned back on). The send half
  // separately retires OUR cursor for peers.
  useEffect(() => {
    if (!pref.hidden) return
    targets.current.clear()
    viewports.current.clear()
    setRoster([])
    setRipples([])
  }, [pref.hidden])

  // The single animation loop: ease every peer toward its document position, map
  // it to a screen position against THIS viewer's scroll (so a peer glides with the
  // content), fade the name tag on stillness, prune anyone who left, and collect
  // who's scrolled off-screen for the edge indicators.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const layer = layerRef.current
      if (layer) {
        const r = layer.getBoundingClientRect()
        const now = Date.now()
        // Receiver geometry: a peer's y is a fraction of the document, so map it to
        // document pixels and subtract our scroll for a screen y. Fall back to
        // viewport mapping until the frame reports real geometry.
        const docH = effectiveDocH(geomRef.current.docH, r.height)
        const scrollY = geomRef.current.scrollY || 0
        let pruned = false
        const above: PeerView[] = []
        const below: PeerView[] = []
        for (const [id, t] of targets.current) {
          if ((t.gone && t.fade <= 0.02) || now - t.lastSeen > CURSOR_TUNING.staleMs) {
            targets.current.delete(id)
            pruned = true
            continue
          }
          // Ease in document space (x by width, y by doc height), then subtract
          // scroll AFTER easing — so scrolling moves a peer with the content
          // instantly (no lerp lag); the lerp only smooths the peer's own motion.
          const tx = t.x * r.width
          const ty = t.y * docH
          const moved = Math.abs(tx - t.cx) + Math.abs(ty - t.cy) > 0.5
          // Reduced motion: snap straight to the target (lerp factor 1, no glide).
          const ease = reducedMotion.current ? 1 : CURSOR_TUNING.lerp
          t.cx += (tx - t.cx) * ease
          t.cy += (ty - t.cy) * ease
          if (moved) t.lastMoveAt = now
          if (t.gone) t.fade = Math.max(0, t.fade - 16 / CURSOR_TUNING.leaveFadeMs)
          const place = placePeer(t.cx, t.cy, { scrollY, docH, viewH: r.height })
          if (t.el) {
            if (place.onScreen) {
              t.el.style.transform = `translate3d(${place.x.toFixed(1)}px, ${place.y.toFixed(1)}px, 0)`
              t.el.style.opacity = t.gone ? t.fade.toFixed(2) : "1"
            } else {
              // Off-screen: the edge indicator stands in for this cursor.
              t.el.style.opacity = "0"
            }
          }
          if (!place.onScreen && !t.gone) {
            const v: PeerView = { id, color: t.color, kind: t.kind, emoji: t.emoji, name: t.name }
            ;(place.side === "above" ? above : below).push(v)
          }
          if (t.labelEl) {
            const hideLabel = !t.gone && now - t.lastMoveAt > CURSOR_TUNING.labelIdleMs
            t.labelEl.style.opacity = hideLabel ? "0" : "1"
          }
        }
        // Forget viewports we haven't heard from in a while (peers who came and went), so
        // the map can't grow unbounded over a long session.
        for (const [id, vp] of viewports.current)
          if (now - vp.t > VIEWPORT_TTL_MS) viewports.current.delete(id)
        // Follow: keep our scroll glued to the followed peer's scroll fraction (read from
        // their viewport, which updates even when their cursor is idle/off-doc — so a reader
        // is followable too). Command only on a real change, so we don't fight the user or
        // spam the frame at 60fps. Leaving presence stops the follow (handled by the page).
        const fid = followingRef.current
        if (fid) {
          const vp = viewports.current.get(fid)
          if (vp && Math.abs(vp.sf - lastFollowSf.current) > 0.0005) {
            lastFollowSf.current = vp.sf
            onFollowScroll.current?.(vp.sf)
          }
        }
        // Re-render React only when the off-screen membership actually changes.
        const key = `${above.map((p) => p.id).join(",")}|${below.map((p) => p.id).join(",")}`
        if (key !== offscreenKey.current) {
          offscreenKey.current = key
          setOffscreen({ above, below })
        }
        if (pruned) markRosterDirty()
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [markRosterDirty])

  return {
    paintFrame,
    setGeom,
    setViewSlide,
    following,
    followingPeer,
    follow,
    unfollow,
    setFollowScroll,
    layer: {
      ref: layerRef,
      roster,
      ripples,
      register,
      above: offscreen.above,
      below: offscreen.below,
      followingPeer,
      onStopFollow: unfollow,
    },
  }
}
