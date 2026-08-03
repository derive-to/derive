import { type RefObject, useCallback, useEffect, useRef, useState } from "react"
import { bareHotkey } from "@/lib/hotkey"

/** How long the presentation controls stay up after the last input. */
const IDLE_MS = 2500

/**
 * Present mode: the deck, the whole screen, and nothing else.
 *
 * What was here before was a single `requestFullscreen(wrapper)` call with nothing
 * watching it. That is most of the pixels but none of the mode: the app never knew
 * it was presenting, so it could not calm the controls, could not say how to get
 * out, could not stop a comment rail or an edit session from riding along — and
 * when the viewer left fullscreen with F11 or Esc (which the browser does without
 * telling anyone who didn't ask), the app carried on as if nothing had happened.
 *
 * So this owns a real state:
 *
 * - **Fullscreen where it exists, a fixed overlay where it doesn't.** iOS Safari
 *   refuses `requestFullscreen` on anything but a video and returns a rejected
 *   promise or nothing at all, so the mode must not depend on it: presenting is our
 *   state, fullscreen is a nicety it uses when the browser allows. The caller
 *   renders the wrapper as a full-viewport layer whenever we are presenting without
 *   it, which is also the honest answer on a phone.
 * - **`fullscreenchange` closes the loop.** Leaving fullscreen by any route the app
 *   didn't initiate ends the mode, so the two can never disagree.
 * - **The keyboard people actually use to present.** Arrows, Space, PageUp/PageDown
 *   and Home/End — Space only here, because on a scrolling page Space is Page Down
 *   and stealing it would be worse than not having it.
 * - **Controls fade when the room settles.** Pointer or key wakes them.
 */
export function usePresentMode(p: {
  /** The element that becomes the screen: the frame plus its overlays. */
  wrapRef: RefObject<HTMLDivElement | null>
  /** A deck is present (announced or sniffed) — without one there is nothing to present. */
  hasDeck: boolean
  /** Slide count, for Home/End. */
  total: number
  cmd: (action: "next" | "prev" | "goto", n?: number) => void
  /** Asked on the way in, and it can say no. The page uses it to close an edit
   *  session — a deck being typed into is not a deck being presented — and to REFUSE
   *  while there are unsaved edits, because the alternative is a discard confirm
   *  opening full-screen in front of an audience. */
  onEnter?: () => boolean
}) {
  const [presenting, setPresenting] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [idle, setIdle] = useState(false)
  const presentingRef = useRef(false)
  presentingRef.current = presenting
  const onEnterRef = useRef(p.onEnter)
  onEnterRef.current = p.onEnter
  const cmdRef = useRef(p.cmd)
  cmdRef.current = p.cmd
  const totalRef = useRef(p.total)
  totalRef.current = p.total

  const exit = useCallback(() => {
    setPresenting(false)
    setIdle(false)
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  }, [])

  const enter = useCallback(() => {
    if (presentingRef.current) return
    if (onEnterRef.current?.() === false) return
    setPresenting(true)
    setIdle(false)
    const el = p.wrapRef.current
    // Fullscreen is best-effort: a rejected promise (iOS, a permissions policy, a
    // gesture the browser didn't like) leaves us presenting in the overlay instead
    // of dropping the mode the viewer just asked for.
    try {
      const r = el?.requestFullscreen?.()
      if (r && typeof r.catch === "function") r.catch(() => {})
    } catch (_e) {}
  }, [p.wrapRef])

  const toggle = useCallback(() => {
    if (presentingRef.current) exit()
    else enter()
  }, [enter, exit])

  // Fullscreen can end without us: Esc, F11, a tab switch on some browsers. Track
  // the browser's truth rather than assuming ours held.
  useEffect(() => {
    const onChange = () => {
      const on = !!document.fullscreenElement
      setFullscreen(on)
      if (!on && presentingRef.current) {
        setPresenting(false)
        setIdle(false)
      }
    }
    document.addEventListener("fullscreenchange", onChange)
    return () => document.removeEventListener("fullscreenchange", onChange)
  }, [])

  // `p` enters from anywhere on the page (never while typing — bareHotkey), and the
  // presenting keyboard drives the deck. Registered as one listener so the two can't
  // disagree about who owns a key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (presentingRef.current && e.key === "Escape" && !e.defaultPrevented) {
        // ALWAYS end the mode, fullscreen or not. In real fullscreen the browser
        // usually eats this press itself and `fullscreenchange` does the work — but
        // "usually" is not a contract (a synthesized key doesn't trigger the
        // browser's own exit at all, which is how this was found), and a presenter
        // pressing Escape with nothing happening is the worst possible moment for a
        // maybe. exit() is idempotent and only calls exitFullscreen if we're in it.
        exit()
        return
      }
      if (!bareHotkey(e)) return
      if (!presentingRef.current) {
        if (p.hasDeck && (e.key === "p" || e.key === "P")) enter()
        return
      }
      setIdle(false)
      const total = totalRef.current
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault() // Space would scroll the host page behind the overlay
        cmdRef.current("next")
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") cmdRef.current("prev")
      else if (e.key === "Home") cmdRef.current("goto", 0)
      else if (e.key === "End") cmdRef.current("goto", Math.max(0, total - 1))
      else if (e.key === "p" || e.key === "P") exit()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [enter, exit, p.hasDeck])

  // Quiet the controls when nothing has happened for a beat. The pointer listener is
  // only bound while presenting, so a reading session pays nothing for it.
  useEffect(() => {
    if (!presenting) return
    let t = window.setTimeout(() => setIdle(true), IDLE_MS)
    const wake = () => {
      setIdle(false)
      clearTimeout(t)
      t = window.setTimeout(() => setIdle(true), IDLE_MS)
    }
    window.addEventListener("pointermove", wake)
    window.addEventListener("pointerdown", wake)
    return () => {
      clearTimeout(t)
      window.removeEventListener("pointermove", wake)
      window.removeEventListener("pointerdown", wake)
    }
  }, [presenting])

  // A deck that goes away under us (version swap to a non-deck, navigation) must not
  // leave the page in a mode with nothing to present.
  useEffect(() => {
    if (!p.hasDeck && presentingRef.current) exit()
  }, [p.hasDeck, exit])

  return {
    presenting,
    /** Presenting, but the browser wouldn't go fullscreen — the caller lays the
     *  wrapper over the viewport itself. */
    overlay: presenting && !fullscreen,
    /** Controls have faded (no input for a beat). */
    idle,
    enter,
    exit,
    toggle,
  }
}
