import { useEffect, useState } from "react"

// Tracks document visibility, reactively. Backgrounded tabs should drop their
// realtime connections (EventSource, heartbeats) instead of holding them open
// indefinitely — an idle tab shouldn't keep its Durable Object billed active.
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden)
  useEffect(() => {
    const on = () => setVisible(!document.hidden)
    document.addEventListener("visibilitychange", on)
    return () => document.removeEventListener("visibilitychange", on)
  }, [])
  return visible
}
