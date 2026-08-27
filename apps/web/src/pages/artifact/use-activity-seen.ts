import { useCallback, useEffect, useRef, useState } from "react"
import { STORAGE_KEYS } from "@/lib/storage-keys"

const keyFor = (shortId: string) => `${STORAGE_KEYS.activitySeen}.${shortId}`

const read = (shortId: string): number | null => {
  try {
    const raw = localStorage.getItem(keyFor(shortId))
    const n = raw ? Number(raw) : Number.NaN
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}
const write = (shortId: string, when: number) => {
  try {
    localStorage.setItem(keyFor(shortId), String(when))
  } catch {
    /* private mode — the marker just doesn't persist */
  }
}

/**
 * The viewer's last visit to an artifact's activity, per browser — what the stream's
 * "New" marker and the header's unread dot are measured against. Read once when the
 * artifact mounts (so the marker holds still while you read) and advanced when the rail
 * closes, the tab hides or unloads, or the page moves to another artifact. A first visit
 * has no marker: nothing is "new" before you've been here.
 *
 * Every advance is an event or a state change, never an effect cleanup: React runs
 * cleanups at mount in StrictMode, and a write there would stamp "now" on first paint —
 * turning everything that happens next into "new".
 */
export function useActivitySeen(shortId: string, railOpen: boolean) {
  const [lastSeen, setLastSeen] = useState<number | null>(() => read(shortId))
  const openRef = useRef(railOpen)
  openRef.current = railOpen

  const markSeen = useCallback(() => {
    const now = Date.now()
    write(shortId, now)
    setLastSeen(now)
  }, [shortId])

  // Closing the rail is "I've seen this": reopening starts clean.
  const wasOpen = useRef(railOpen)
  useEffect(() => {
    if (wasOpen.current && !railOpen) markSeen()
    wasOpen.current = railOpen
  }, [railOpen, markSeen])

  // Moving to another artifact with the rail open counts for the one being left; the
  // marker for the new one is read fresh.
  const prev = useRef(shortId)
  useEffect(() => {
    if (prev.current !== shortId) {
      if (openRef.current) write(prev.current, Date.now())
      prev.current = shortId
      setLastSeen(read(shortId))
    }
  }, [shortId])

  // Hiding or unloading the tab with the rail open also counts — the storage advances,
  // and a tab that comes back keeps its marker where it was.
  useEffect(() => {
    const leave = () => {
      if (openRef.current) write(shortId, Date.now())
    }
    const onVisibility = () => {
      if (document.visibilityState === "hidden") leave()
    }
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pagehide", leave)
    return () => {
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pagehide", leave)
    }
  }, [shortId])

  return { lastSeen, markSeen }
}
