import { useEffect, useRef, useState } from "react"
import { PENDING } from "./pending"

// Mirrors TanStack Router's pending timing (PENDING) for in-component,
// mount-then-fetch first loads (library, people, profile, settings sections,
// diff, insights): returns false until `pending` has held for delayMs — so a
// cache-warm load never flashes a skeleton — and once true stays true for at
// least minShownMs, so a just-too-slow load doesn't strobe. Flash-prevention,
// not motion; it runs the same under prefers-reduced-motion.
export const useDelayedPending = (
  pending: boolean,
  { delayMs = PENDING.delayMs, minShownMs = PENDING.minShownMs } = {},
): boolean => {
  const [shown, setShown] = useState(false)
  const shownAt = useRef(0)
  useEffect(() => {
    if (pending && !shown) {
      const t = setTimeout(() => {
        shownAt.current = Date.now()
        setShown(true)
      }, delayMs)
      return () => clearTimeout(t)
    }
    if (!pending && shown) {
      const held = Date.now() - shownAt.current
      const t = setTimeout(() => setShown(false), Math.max(0, minShownMs - held))
      return () => clearTimeout(t)
    }
  }, [pending, shown, delayMs, minShownMs])
  return shown
}
