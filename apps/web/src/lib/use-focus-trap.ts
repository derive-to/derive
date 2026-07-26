import { type RefObject, useEffect } from "react"

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * Trap keyboard focus inside `ref` while `active`: move focus in on open, cycle
 * Tab/Shift+Tab within the dialog, and restore focus to the previously-focused
 * element on close. For custom full-screen overlays that declare
 * role="dialog"/aria-modal but aren't Radix Dialogs (which already trap focus) —
 * `aria-modal` hides the background from screen readers, but a keyboard/motor
 * user could otherwise Tab out into that now-inert background.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return
    const node = ref.current
    if (!node) return
    const previously = document.activeElement as HTMLElement | null
    const focusables = () =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      )

    // Move focus into the dialog (first focusable, else the container itself).
    const first = focusables()[0]
    if (first) first.focus()
    else {
      node.tabIndex = -1
      node.focus()
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return
      const items = focusables()
      const firstEl = items[0]
      const lastEl = items[items.length - 1]
      if (!firstEl || !lastEl) {
        e.preventDefault()
        return
      }
      const here = document.activeElement
      if (e.shiftKey && (here === firstEl || !node.contains(here))) {
        e.preventDefault()
        lastEl.focus()
      } else if (!e.shiftKey && (here === lastEl || !node.contains(here))) {
        e.preventDefault()
        firstEl.focus()
      }
    }
    node.addEventListener("keydown", onKey)
    return () => {
      node.removeEventListener("keydown", onKey)
      previously?.focus?.()
    }
  }, [active, ref])
}
