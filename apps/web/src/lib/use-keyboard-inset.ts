import { useEffect, useState } from "react"

/** What the on-screen keyboard currently covers. `null` when it's closed. */
export interface KeyboardInset {
  /** Pixels of the layout viewport hidden behind the keyboard. */
  inset: number
  /** Height of the still-visible area. */
  height: number
}

/**
 * The measurement itself, as pure arithmetic so it can be tested without a DOM.
 * A shrink has to clear {@link KEYBOARD_MIN_INSET} to count as a keyboard — that is
 * what rules out Safari's ~60-115px toolbar collapse, which otherwise looks
 * identical to a small keyboard and would pin the layout for no reason.
 */
export const KEYBOARD_MIN_INSET = 150

export function keyboardInsetFrom(
  layoutHeight: number,
  visualHeight: number,
  visualOffsetTop: number,
): KeyboardInset | null {
  const inset = Math.max(0, layoutHeight - visualHeight - visualOffsetTop)
  return inset > KEYBOARD_MIN_INSET
    ? { inset: Math.round(inset), height: Math.round(visualHeight) }
    : null
}

/**
 * Track the on-screen keyboard through `visualViewport`.
 *
 * iOS keeps `position: fixed` put when the keyboard opens and never resizes the
 * layout viewport, so anything anchored to the bottom — a sheet, or the bottom half
 * of a document you're typing into — simply hides behind it. Measuring the visual
 * viewport is the only way to learn how much is covered.
 *
 * Measured against `clientHeight` (keyboard-stable on iOS). A shrink has to clear
 * 150px to count, which rules out the ~60-115px Safari toolbar collapse that would
 * otherwise false-trigger. rAF-coalesced and change-guarded, so the scroll/resize
 * bursts iOS emits during the keyboard animation don't thrash React.
 *
 * Extracted from the mobile comments sheet, which discovered every one of those
 * constraints the hard way; inline editing needs the same measurement to keep the
 * block you're typing in above the keyboard.
 */
export function useKeyboardInset(): KeyboardInset | null {
  const [kb, setKb] = useState<KeyboardInset | null>(null)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    let raf = 0
    const measure = () => {
      const next = keyboardInsetFrom(document.documentElement.clientHeight, vv.height, vv.offsetTop)
      setKb((prev) => {
        if (!prev && !next) return prev
        if (prev && next && prev.inset === next.inset && prev.height === next.height) return prev
        return next
      })
    }
    const update = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    }
    measure()
    vv.addEventListener("resize", update)
    vv.addEventListener("scroll", update)
    return () => {
      cancelAnimationFrame(raf)
      vv.removeEventListener("resize", update)
      vv.removeEventListener("scroll", update)
    }
  }, [])
  return kb
}
