import { useEffect, useState } from "react"

// Matches a max-width breakpoint, reactively. SSR-safe (assumes desktop until
// the client mounts). Drives the mobile layout branches across the app. 640 is
// Tailwind's `sm`, so JS branches and `max-sm:` utilities stay in lockstep.
export function useIsMobile(bp = 640): boolean {
  const [m, setM] = useState(
    () => typeof window !== "undefined" && window.matchMedia(`(max-width:${bp}px)`).matches,
  )
  useEffect(() => {
    const mq = window.matchMedia(`(max-width:${bp}px)`)
    const on = () => setM(mq.matches)
    on()
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [bp])
  return m
}
