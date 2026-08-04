import { useEffect, useRef, useState } from "react"
import { bareHotkey } from "@/lib/hotkey"
import { STORAGE_KEYS } from "@/lib/storage-keys"
import type { Panel } from "./types"

const PANEL_KEY = STORAGE_KEYS.commentsPanel
const loadPanel = (): Panel => {
  try {
    // Only "hidden" is remembered as closed; anything else (incl. a legacy "rail")
    // opens.
    return localStorage.getItem(PANEL_KEY) === "hidden" ? "hidden" : "open"
  } catch {
    return "open"
  }
}

/**
 * The comments panel's open/hidden state and its two side effects: it's persisted
 * per device across visits, and the `c` hotkey toggles it. Escape is wired through
 * the same keydown listener (it routes to the page's composer cancel via
 * `onEscape`) so the page keeps one listener, not two. Phones are ALWAYS open:
 * the sheet's docked peek bar is the sole comments entry point on a phone (no
 * top-bar toggle, no `c` key), so hidden is not a reachable state there — they
 * start open, and the page clamps with `effectivePanel` against a persisted
 * desktop "hidden" leaking across a resize. Desktop restores the saved state.
 */
export function useCommentsPanel(onEscape: () => void) {
  const [panel, setPanel] = useState<Panel>(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width:640px)").matches
      ? "open"
      : loadPanel(),
  )

  // Persist the collapse state — desktop only. On a phone-width viewport the panel
  // is forced open (above), and writing that would clobber a desktop "hidden"
  // preference the moment a desktop window got narrowed below the breakpoint.
  useEffect(() => {
    if (window.matchMedia("(max-width:640px)").matches) return
    try {
      localStorage.setItem(PANEL_KEY, panel)
    } catch {
      /* private mode — ignore */
    }
  }, [panel])

  // Keep the latest onEscape without resubscribing the listener every render.
  const escRef = useRef(onEscape)
  escRef.current = onEscape
  // Keyboard: 'c' toggles the panel open/closed; Escape cancels a composer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        escRef.current()
        return
      }
      if (!bareHotkey(e)) return
      if (e.key === "c" || e.key === "C") setPanel((p) => (p === "open" ? "hidden" : "open"))
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return { panel, setPanel }
}
