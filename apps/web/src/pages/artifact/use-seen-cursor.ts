import { useMutation, useQuery } from "@tanstack/react-query"
import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "@/api"
import { activitySeenQuery } from "@/lib/queries"
import { STORAGE_KEYS } from "@/lib/storage-keys"

/** How long the reader must have the stream in view before "seen" advances. */
const DWELL_MS = 2_000
/** Writes are spaced at least this far apart (Slack's own guidance for read cursors). */
const WRITE_GAP_MS = 5_000
/** Leaving and coming back within this window is the same visit: the line stays put. */
const VISIT_MS = 30 * 60_000

type Visit = { at: number | null; touched: number }
const visitKey = (scope: string) => `${STORAGE_KEYS.seenVisit}.${scope}`
const readVisit = (scope: string): Visit | null => {
  try {
    const raw = sessionStorage.getItem(visitKey(scope))
    const v = raw ? (JSON.parse(raw) as Visit) : null
    return v && typeof v.touched === "number" ? v : null
  } catch {
    return null
  }
}
const writeVisit = (scope: string, v: Visit) => {
  try {
    sessionStorage.setItem(visitKey(scope), JSON.stringify(v))
  } catch {
    /* private mode — the visit just doesn't survive a reload */
  }
}

// The pre-cursor stamp lived in localStorage, per browser: `ws.<org>` for the page,
// `<short_id>` for a rail. Imported once into the server cursor so nobody's line jumps on
// upgrade, then removed.
const legacyKey = (scope: string) =>
  `${STORAGE_KEYS.activitySeen}.${scope.replace(/^ws:/, "ws.").replace(/^artifact:/, "")}`
const takeLegacy = (scope: string): number | null => {
  try {
    const raw = localStorage.getItem(legacyKey(scope))
    if (raw === null) return null
    localStorage.removeItem(legacyKey(scope))
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : null)

/**
 * The reader's position in an activity stream — what the "New" marker is measured
 * against — as a server-side cursor per (user, scope), read once per VISIT and held
 * still while they read.
 *
 * A visit is the stretch of time they are on the surface, including in-app round trips
 * (Answer → the document → back): the snapshot lives in sessionStorage and is reused for
 * half an hour, so the line does not move just because they went to act on one item. The
 * stored cursor advances underneath it after a short visible dwell, on each later arrival,
 * and when the rail closes — never merely because the tab was hidden, and never in an
 * effect cleanup (StrictMode runs those at mount). Every device draws the line in the same
 * place, because the position is the account's, not the browser's.
 *
 * The server accepts a manual rewind ("mark new from here"); no surface offers it yet.
 */
export function useSeenCursor(
  scope: string,
  opts: { open: boolean; enabled?: boolean; arrivals?: number },
) {
  const { open, enabled = true, arrivals = 0 } = opts
  const query = useQuery({ ...activitySeenQuery(scope), enabled })
  const write = useMutation({
    mutationFn: (body: { at: string; manual?: boolean }) => api.setActivitySeen({ scope, ...body }),
    meta: { errorToast: false },
  })
  const writeRef = useRef(write.mutate)
  writeRef.current = write.mutate

  const [lastSeen, setLastSeen] = useState<number | null | undefined>(undefined)

  // The visit snapshot: reuse a recent one, else take the server value (importing the
  // pre-cursor local stamp the first time, so an upgrade keeps the reader's place).
  useEffect(() => {
    if (!enabled) return
    if (query.data === undefined) return
    const visit = readVisit(scope)
    const now = Date.now()
    // A first visit draws no line, and a line-less visit is not worth continuing: coming
    // back reads the cursor the dwell stamped, so what arrived in between is new.
    if (visit && visit.at !== null && now - visit.touched < VISIT_MS) {
      setLastSeen(visit.at)
      writeVisit(scope, { ...visit, touched: now })
      return
    }
    let at = ms(query.data.seen_at)
    if (at === null) {
      const legacy = takeLegacy(scope)
      if (legacy !== null) {
        at = legacy
        writeRef.current({ at: new Date(legacy).toISOString(), manual: true })
      }
    }
    setLastSeen(at)
    writeVisit(scope, { at, touched: now })
  }, [scope, enabled, query.data])

  // Advancing the stored cursor (not the snapshot): spaced writes, forward-only server-side.
  const lastWrite = useRef(0)
  const advance = useCallback(() => {
    const now = Date.now()
    if (now - lastWrite.current < WRITE_GAP_MS) return
    lastWrite.current = now
    writeRef.current({ at: new Date(now).toISOString() })
    const visit = readVisit(scope)
    if (visit) writeVisit(scope, { ...visit, touched: now })
  }, [scope])

  // Seen = the surface open and the tab visible for a short dwell; each new arrival while
  // it stays open starts the dwell again, so what lands while the reader is here is seen
  // too. Hiding the tab only stops the clock.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each arrival restarts the dwell
  useEffect(() => {
    if (!enabled || !open || lastSeen === undefined) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      clearTimeout(timer)
      if (document.visibilityState === "visible") timer = setTimeout(advance, DWELL_MS)
    }
    arm()
    document.addEventListener("visibilitychange", arm)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", arm)
    }
  }, [enabled, open, lastSeen, arrivals, advance])

  // Closing the rail is "I've seen this" in so many words.
  const wasOpen = useRef(open)
  useEffect(() => {
    if (wasOpen.current && !open && enabled) advance()
    wasOpen.current = open
  }, [open, enabled, advance])

  return { lastSeen: lastSeen ?? null, ready: lastSeen !== undefined }
}
