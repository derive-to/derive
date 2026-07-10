import { useEffect, useState } from "react"

// Tracks browser connectivity, reactively (mirrors usePageVisible). A dropped network takes SSE
// streams + heartbeats down, and native EventSource is documented NOT to reliably auto-reconnect
// after the browser returns online — so realtime hooks GATE their stream on this and re-establish
// it the moment connectivity is back (the effect re-runs when `online` flips, no manual trigger).
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine)
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine)
    window.addEventListener("online", sync)
    window.addEventListener("offline", sync)
    return () => {
      window.removeEventListener("online", sync)
      window.removeEventListener("offline", sync)
    }
  }, [])
  return online
}
