import { useEffect, useState } from "react"

// Matches a max-width breakpoint, reactively. SSR-safe (assumes desktop until
// the client mounts). Drives the mobile layout branches across the app. 640 is
// Tailwind's `sm`, so JS branches and `max-sm:` utilities stay in lockstep.
export function useIsMobile(bp = 640): boolean {
  // Never read matchMedia during the initial client render: prerendering assumes
  // desktop, and a mobile-first client value would make Sidebar render a Sheet
  // where the server emitted the desktop rail. Set the real value after mount,
  // when changing the DOM cannot break hydration.
  const [m, setM] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia(`(max-width:${bp}px)`)
    const on = () => setM(mq.matches)
    on()
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [bp])
  return m
}

// Is the primary input a FINGER? Width is a proxy for "phone" and a bad proxy for
// "touch": a phone in landscape is 844px wide and a tablet is wider still, while a
// narrow desktop window is neither. Anything sized for thumbs (hit targets, "tap"
// rather than "click") should ask this instead of the breakpoint.
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches,
  )
  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse)")
    const on = () => setCoarse(mq.matches)
    on()
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [])
  return coarse
}
