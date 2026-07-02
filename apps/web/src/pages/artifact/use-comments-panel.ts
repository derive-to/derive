import { useEffect, useRef, useState } from "react"
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
 * `onEscape`) so the page keeps one listener, not two. Phones start hidden
 * (document-first); desktop restores the saved state.
 */
export function useCommentsPanel(onEscape: () => void) {
  const [panel, setPanel] = useState<Panel>(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width:640px)").matches
      ? "hidden"
      : loadPanel(),
  )

  // Persist the collapse state.
  useEffect(() => {
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
      const el = e.target as HTMLElement
      if (e.key === "Escape") {
        escRef.current()
        return
      }
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      if (el && /^(input|textarea|select)$/i.test(el.tagName)) return
      if (e.key === "c" || e.key === "C") setPanel((p) => (p === "open" ? "hidden" : "open"))
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return { panel, setPanel }
}
