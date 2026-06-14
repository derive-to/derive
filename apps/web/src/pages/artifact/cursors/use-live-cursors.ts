import { useCallback, useEffect, useRef, useState } from "react"
import { API_BASE } from "@/api"
import { useCursorPref } from "@/ctx"
import { CURSOR_FALLBACK, CURSOR_TUNING, type CursorFrame } from "@/lib/cursors"

// All of the live-cursor realtime behaviour, kept out of the page and out of the
// presence/comments hook:
//  - sending our own pointer (throttled), our chosen look, and explicit
//    leave / tap signals;
//  - a focus/idle state machine so a blurred or idle tab stops showing a cursor
//    at once (no more cursors lingering on an abandoned tab);
//  - painting peers as a single rAF-driven overlay that eases (lerps) toward each
//    peer's latest position, so cursors glide instead of teleporting between
//    throttled samples; the name tag fades after a beat of stillness.
//
// React only re-renders when the *roster* changes (a peer joins, leaves, or
// restyles) or a ripple fires; every-frame motion is written straight to the
// DOM via refs, never through React.

/** A peer entry the overlay mounts/unmounts and styles (no per-frame churn). */
export interface PeerView {
  id: string
  color: string
  kind: "arrow" | "emoji"
  emoji?: string
  name: string
}

/** A one-shot click ripple. */
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

export function useLiveCursors(shortId: string): {
  onPointerMove: (x: number, y: number) => void
  onPointerLeave: () => void
  onTap: (x: number, y: number) => void
  paintFrame: (f: CursorFrame) => void
  setGeom: (g: { scrollY: number; docH: number; viewH: number }) => void
  layer: CursorLayerHandle
} {
  const { pref } = useCursorPref()
  // Always send the latest pick without re-binding the send callbacks.
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
  const selfId = useRef("")
  if (!selfId.current) selfId.current = Math.random().toString(36).slice(2, 9)

  // Peer animation state (ref) + the React-visible roster/ripples (state).
  const targets = useRef(new Map<string, PeerTarget>())
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

  // Local send + lifecycle state.
  const xy = useRef<[number, number] | null>(null)
  const sentAt = useRef(0)
  const live = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rippleKey = useRef(0)

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

  const send = useCallback(
    (extra: Record<string, unknown>) => {
      const pt = xy.current ?? [0, 0]
      fetch(`${API_BASE}/v1/artifacts/${shortId}/cursor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        keepalive: true, // so a leave fired at unload still flushes
        body: JSON.stringify({ id: selfId.current, x: pt[0], y: pt[1], ...extra }),
      }).catch(() => {})
    },
    [shortId],
  )

  // Our current look as wire fields (reads a ref, so it's stable).
  const look = useCallback(() => {
    const p = prefRef.current
    return { color: p.color, kind: p.kind, emoji: p.kind === "emoji" ? p.emoji : undefined }
  }, [])

  const sendCursor = useCallback(() => {
    if (prefRef.current.hidden) return
    sentAt.current = Date.now()
    send(look())
  }, [send, look])

  const sendLeave = useCallback(() => {
    if (!live.current) return
    live.current = false
    send({ gone: true })
  }, [send])

  const onPointerMove = useCallback(
    (x: number, y: number) => {
      if (prefRef.current.hidden) return
      xy.current = [x, y]
      live.current = true
      if (idleTimer.current) clearTimeout(idleTimer.current)
      idleTimer.current = setTimeout(sendLeave, CURSOR_TUNING.idleMs)
      if (Date.now() - sentAt.current >= CURSOR_TUNING.sendThrottleMs) sendCursor()
    },
    [sendCursor, sendLeave],
  )

  const onPointerLeave = useCallback(() => sendLeave(), [sendLeave])

  const onTap = useCallback(
    (x: number, y: number) => {
      if (prefRef.current.hidden) return
      xy.current = [x, y]
      live.current = true
      send({ ...look(), tap: true })
    },
    [send, look],
  )

  const register = useCallback((id: string, el: HTMLElement | null) => {
    const t = targets.current.get(id)
    if (!t) return
    t.el = el
    t.labelEl = el?.querySelector<HTMLElement>("[data-cursor-label]") ?? null
  }, [])

  // Incoming peer frame (fed from the shared SSE stream in use-artifact-live).
  const paintFrame = useCallback(
    (f: CursorFrame) => {
      if (!f?.id || f.id === selfId.current) return
      // Viewer opted out of the cursor layer — ignore every incoming peer.
      if (prefRef.current.hidden) return

      if (f.tap && !reducedMotion.current) {
        const key = ++rippleKey.current
        setRipples((rs) => [...rs, { key, x: f.x, y: f.y, color: f.color ?? CURSOR_FALLBACK }])
        setTimeout(
          () => setRipples((rs) => rs.filter((r) => r.key !== key)),
          CURSOR_TUNING.rippleMs,
        )
      }

      const existing = targets.current.get(f.id)
      if (f.gone) {
        if (existing) existing.gone = true // the rAF loop fades it out, then prunes
        return
      }

      const now = Date.now()
      if (!existing) {
        // New peer: seed the eased position at the target so it appears in place.
        // y is document-normalized, so seed cy in document pixels (eased there).
        const r = layerRef.current?.getBoundingClientRect()
        const docH = geomRef.current.docH || r?.height || 0
        targets.current.set(f.id, {
          x: f.x,
          y: f.y,
          cx: f.x * (r?.width ?? 0),
          cy: f.y * docH,
          color: f.color ?? CURSOR_FALLBACK,
          kind: f.kind ?? "arrow",
          emoji: f.emoji,
          name: f.name ?? "Guest",
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
      existing.gone = false
      existing.fade = 1
      existing.lastSeen = now
    },
    [markRosterDirty],
  )

  // Hiding opts the viewer out of the whole layer: retire our own cursor for
  // peers right away, drop everyone else's, and (via the guards above) stop
  // sending and painting until it's turned back on.
  useEffect(() => {
    if (!pref.hidden) return
    sendLeave()
    targets.current.clear()
    setRoster([])
    setRipples([])
  }, [pref.hidden, sendLeave])

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
        const docH = geomRef.current.docH || r.height || 1
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
          const screenY = t.cy - scrollY
          const onScreen = screenY >= 0 && screenY <= r.height
          if (t.el) {
            if (onScreen) {
              t.el.style.transform = `translate3d(${t.cx.toFixed(1)}px, ${screenY.toFixed(1)}px, 0)`
              t.el.style.opacity = t.gone ? t.fade.toFixed(2) : "1"
            } else {
              // Off-screen: the edge indicator stands in for this cursor.
              t.el.style.opacity = "0"
            }
          }
          if (!onScreen && !t.gone) {
            const v: PeerView = { id, color: t.color, kind: t.kind, emoji: t.emoji, name: t.name }
            ;(screenY < 0 ? above : below).push(v)
          }
          if (t.labelEl) {
            const hideLabel = !t.gone && now - t.lastMoveAt > CURSOR_TUNING.labelIdleMs
            t.labelEl.style.opacity = hideLabel ? "0" : "1"
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

  // Local focus/idle/leave: blur, tab-hide, idle, or unload all retire our cursor
  // for peers immediately; a slow re-send keeps a still-but-present pointer alive.
  useEffect(() => {
    const onHide = () => {
      if (document.hidden) sendLeave()
    }
    const onBlur = () => {
      if (blurTimer.current) clearTimeout(blurTimer.current)
      blurTimer.current = setTimeout(sendLeave, CURSOR_TUNING.blurDebounceMs)
    }
    const onFocus = () => {
      if (blurTimer.current) clearTimeout(blurTimer.current)
    }
    document.addEventListener("visibilitychange", onHide)
    window.addEventListener("blur", onBlur)
    window.addEventListener("focus", onFocus)
    window.addEventListener("pagehide", sendLeave)
    const resend = setInterval(() => {
      if (live.current && xy.current) sendCursor()
    }, CURSOR_TUNING.resendMs)
    return () => {
      document.removeEventListener("visibilitychange", onHide)
      window.removeEventListener("blur", onBlur)
      window.removeEventListener("focus", onFocus)
      window.removeEventListener("pagehide", sendLeave)
      clearInterval(resend)
      if (idleTimer.current) clearTimeout(idleTimer.current)
      if (blurTimer.current) clearTimeout(blurTimer.current)
    }
  }, [sendLeave, sendCursor])

  return {
    onPointerMove,
    onPointerLeave,
    onTap,
    paintFrame,
    setGeom,
    layer: {
      ref: layerRef,
      roster,
      ripples,
      register,
      above: offscreen.above,
      below: offscreen.below,
    },
  }
}
