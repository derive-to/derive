import { type RefObject, useCallback, useEffect, useRef, useState } from "react"
import { COMPOSER_ID, clamp, consumeWheel, normalizeWheel, pinOffsetBounds } from "./lib/layout"
import type { FrameGeom } from "./types"

/**
 * The imperative half of the pinned margin. Cards render (in React) at DOC-ABSOLUTE
 * Ys inside a single layer; this hook moves that layer with the document by writing
 * `translateY(datum − scrollY − offset)` straight to the DOM on every geometry
 * notification — so scroll never re-renders React, and the cards' own 200ms
 * transform transition fires only on real layout changes (activation, height
 * changes, anchors moving), never on scroll tracking. Same pattern as the
 * live-cursor overlay (use-cursor-paint): refs + direct style writes; React owns
 * only what actually changes shape.
 *
 * Its three jobs:
 *  - datum: the vertical offset between the iframe's top and the zone's top,
 *    MEASURED (rects), not assumed — the panel header, review card, bundle bar,
 *    and past-version banner all move it, and assuming it was the old
 *    "pins misaligned during review rounds" bug class.
 *  - offset: the panel's local scroll-like term for cards the doc scroll alone
 *    can't show — a dense cluster overflowing below (positive), or the band above
 *    the zone's top where the doc's first lines pin (negative; see pinOffsetBounds).
 *  - wheel: over the panel, an inner scrollable consumes natively first, then the
 *    offset absorbs what it legally can, and the remainder forwards to the document
 *    (the cross-origin frame can't scroll-chain natively).
 */

/** The layout snapshot the zone computes per render; consumed here via ref. */
export type PinLayout = {
  /** Card layout Ys (doc-absolute), keyed by pin id (incl. the composer). */
  pos: Record<string, number>
  heights: Record<string, number>
  /** Which pins have a real position (an unlocated pin renders invisible). */
  located: Record<string, boolean>
  /** Topmost card's layout Y (doc-absolute). */
  minY: number
  /** Bottom of the lowest card in the relaxed stack (doc-absolute). */
  maxBottom: number
  /** The active item's (composer / selected thread) layout Y, if any. */
  activeY: number | null
}

/** Pins currently outside the zone's viewport, per edge: how many, and the
 *  nearest one to jump to. Null when that edge has none. */
export type OffscreenPins = {
  above: { count: number; id: string } | null
  below: { count: number; id: string } | null
}

const DEFAULT_CARD_H = 116

// Can `el` still consume a wheel tick in this direction natively? Only real
// scroll containers count — a clamped comment body is overflow-hidden with
// excess scrollHeight, and must NOT swallow the gesture.
const canScroll = (el: HTMLElement, down: boolean): boolean => {
  if (el.scrollHeight <= el.clientHeight + 1) return false
  const oy = getComputedStyle(el).overflowY
  if (oy !== "auto" && oy !== "scroll") return false
  return down ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0
}

export function usePinLayer(p: {
  frameRef: RefObject<HTMLIFrameElement | null>
  subscribeGeom: (cb: (g: FrameGeom) => void) => () => void
  onScrollDoc: (dy: number) => void
  layout: PinLayout
}) {
  const { frameRef, subscribeGeom, onScrollDoc } = p
  const zoneRef = useRef<HTMLDivElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)

  const geom = useRef<FrameGeom>({ scrollY: 0, docH: 0, viewH: 0 })
  const datum = useRef(0)
  const zoneH = useRef(0)
  const offset = useRef(0)
  const layout = useRef<PinLayout>(p.layout)

  // Which pins sit outside the zone right now (and the nearest one per edge, for
  // the jump pills). Computed on every reposition but pushed to React ONLY when
  // the membership changes — an edge crossing, not a scroll frame (the cursor
  // layer's offscreenKey pattern), so scroll still never re-renders per frame.
  const [offscreen, setOffscreen] = useState<OffscreenPins>({ above: null, below: null })
  const offscreenKey = useRef("")
  const updateOffscreen = useCallback(() => {
    const l = layout.current
    if (!zoneH.current) return
    const base = datum.current - geom.current.scrollY - offset.current
    let aboveCount = 0
    let aboveId = ""
    let aboveY = Number.NEGATIVE_INFINITY
    let belowCount = 0
    let belowId = ""
    let belowY = Number.POSITIVE_INFINITY
    for (const id in l.pos) {
      // The composer is never "a comment you're missing"; unlocated pins have no
      // real position to report.
      if (id === COMPOSER_ID || l.located[id] === false) continue
      const y = (l.pos[id] ?? 0) + base
      const h = l.heights[id] ?? DEFAULT_CARD_H
      if (y + h < 8) {
        aboveCount++
        if (y > aboveY) {
          aboveY = y
          aboveId = id
        }
      } else if (y > zoneH.current - 8) {
        belowCount++
        if (y < belowY) {
          belowY = y
          belowId = id
        }
      }
    }
    const key = `${aboveCount}:${aboveId}|${belowCount}:${belowId}`
    if (key === offscreenKey.current) return
    offscreenKey.current = key
    setOffscreen({
      above: aboveCount ? { count: aboveCount, id: aboveId } : null,
      below: belowCount ? { count: belowCount, id: belowId } : null,
    })
  }, [])

  const apply = useCallback(() => {
    const el = layerRef.current
    if (!el) return
    el.style.transform = `translate3d(0, ${Math.round(datum.current - geom.current.scrollY - offset.current)}px, 0)`
    updateOffscreen()
  }, [updateOffscreen])

  // `withActive` keeps the floor open for a revealed active item (an open
  // composer, the selected thread): layout/datum re-fits must not yank it. A
  // real DOC SCROLL passes false — scrolling is user intent, and the one promise
  // this layer makes is that scrolling re-aligns every card with its highlight,
  // so any reveal offset unwinds rather than dragging the whole stack around.
  const bounds = useCallback(
    (withActive: boolean) =>
      pinOffsetBounds({
        minY: layout.current.minY,
        maxBottom: layout.current.maxBottom,
        activeY: withActive ? layout.current.activeY : null,
        datum: datum.current,
        scrollY: geom.current.scrollY,
        zoneH: zoneH.current,
      }),
    [],
  )

  // Re-fit the offset to the current geometry, then reposition. This replaces the
  // old self-scroll bookkeeping wholesale: as the doc scrolls away from a cluster
  // the legal range shrinks and the offset unwinds by clamping; a jump far away
  // zeroes it the same way; and there is no "was this scroll ours?" flag to desync.
  const clampApply = useCallback(
    (withActive = true) => {
      const b = bounds(withActive)
      offset.current = clamp(offset.current, b.min, b.max)
      apply()
    },
    [bounds, apply],
  )

  // datum + zone height, from rects. Called on geometry notifications (piggybacks
  // the scroll stream, and survives the iframe element being replaced on a
  // RenderStage retry), on the zone's ResizeObserver, and on window resize.
  const measure = useCallback(() => {
    const zone = zoneRef.current
    const frame = frameRef.current
    if (!zone || !frame) return
    const zr = zone.getBoundingClientRect()
    const d = Math.round(frame.getBoundingClientRect().top - zr.top)
    const h = Math.round(zr.height)
    if (d === datum.current && h === zoneH.current) return
    datum.current = d
    zoneH.current = h
    clampApply()
  }, [frameRef, clampApply])

  // The layout snapshot lands post-commit (renders happen only on real layout
  // changes now), then the offset re-fits to the new stack.
  useEffect(() => {
    layout.current = p.layout
    clampApply()
  })

  useEffect(() => {
    return subscribeGeom((g) => {
      const scrolled = g.scrollY !== geom.current.scrollY
      geom.current = g
      measure()
      clampApply(!scrolled)
    })
  }, [subscribeGeom, measure, clampApply])

  useEffect(() => {
    const zone = zoneRef.current
    if (!zone) return
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(zone)
    const frame = frameRef.current
    if (frame) ro.observe(frame)
    window.addEventListener("resize", measure)
    return () => {
      ro.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [measure, frameRef])

  // Wheel over the panel: inner scrollables first, then the local offset, then the
  // document — split within one event, so the tick that exhausts the local room
  // still moves the doc by its remainder. preventDefault needs non-passive.
  useEffect(() => {
    const zone = zoneRef.current
    if (!zone) return
    const onWheel = (e: WheelEvent) => {
      const down = e.deltaY > 0
      for (
        let el = e.target instanceof Element ? e.target : null;
        el && el !== zone;
        el = el.parentElement
      ) {
        if (el instanceof HTMLElement && canScroll(el, down)) return
      }
      e.preventDefault()
      const delta = normalizeWheel(e.deltaY, e.deltaMode, geom.current.viewH || zoneH.current)
      const b = bounds(true)
      const r = consumeWheel(offset.current, delta, b.min, b.max)
      if (r.offset !== offset.current) {
        offset.current = r.offset
        apply()
      }
      if (r.forward) onScrollDoc(r.forward)
    }
    zone.addEventListener("wheel", onWheel, { passive: false })
    return () => zone.removeEventListener("wheel", onWheel)
  }, [onScrollDoc, bounds, apply])

  // Slide a card into the zone's view by adjusting the offset — the replacement for
  // native scrollIntoView/focus-scrolling, which overflow:clip deliberately disables.
  // Fired on composer mount, thread activation, and keyboard focus entering a card.
  const reveal = useCallback(
    (id: string) => {
      const l = layout.current
      const y = l.pos[id]
      if (y == null) return
      const h = l.heights[id] ?? DEFAULT_CARD_H
      const layerY = y + datum.current - geom.current.scrollY // zone-local at offset 0
      // Offset placing the card fully inside [0, zoneH]; a card taller than the
      // zone favors its top edge.
      const fit = clamp(offset.current, Math.min(layerY + h - zoneH.current, layerY), layerY)
      const b = bounds(true)
      // A reveal may reach below the general floor for its own target (the active
      // item's term in pinOffsetBounds keeps it there through non-scroll clamps;
      // an actual doc scroll unwinds it — user intent wins).
      offset.current = clamp(fit, Math.min(b.min, layerY), b.max)
      apply()
    },
    [bounds, apply],
  )

  // Keyboard reach into a buried card (Tab into its reply box / buttons): reveal it,
  // since the clipped zone no longer focus-scrolls natively.
  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    const onFocus = (e: FocusEvent) => {
      const pin = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-pin]") : null
      if (pin?.dataset.pin) reveal(pin.dataset.pin)
    }
    layer.addEventListener("focusin", onFocus)
    return () => layer.removeEventListener("focusin", onFocus)
  }, [reveal])

  return { zoneRef, layerRef, reveal, offscreen }
}
