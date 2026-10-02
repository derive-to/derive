import { useRef } from "react"
import { STORAGE_KEYS } from "@/lib/storage-keys"

type Place = { slide: number | null; at: string }

const parse = (hash: string): Place | null => {
  const slide = /^#slide=(\d+)$/.exec(hash)
  if (slide) return { slide: Math.max(0, Number(slide[1]) - 1), at: "" }
  const at = /^#at=(.+)$/.exec(hash)
  return at?.[1] ? { slide: null, at: at[1].slice(0, 300) } : null
}

const toHash = (p: Place) =>
  p.slide !== null ? `#slide=${p.slide + 1}` : p.at ? `#at=${p.at}` : ""

const load = (shortId: string): Place | null => {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEYS.place + shortId)
    return raw ? parse(raw) : null
  } catch {
    return null
  }
}
const save = (shortId: string, p: Place) => {
  try {
    const hash = toHash(p)
    if (hash) window.sessionStorage.setItem(STORAGE_KEYS.place + shortId, hash)
    else window.sessionStorage.removeItem(STORAGE_KEYS.place + shortId)
  } catch {}
}

/** This tab's saved place is for a refresh (or back/forward into the page), as the URL
 *  was: only the first artifact this document load restores reads it. Opening one again
 *  from inside the app starts at the top, as it always has. */
let reloaded = (() => {
  try {
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined
    return nav?.type === "reload" || nav?.type === "back_forward"
  } catch {
    return false
  }
})()

/** Each open artifact's place right now, for a copied link (see placeHash). */
const live = new Map<string, Place>()

/** The reader's place as a link suffix (`#slide=N` / `#at=…`), or "" at the top. */
export const placeHash = (shortId: string): string => {
  const p = live.get(shortId)
  return p ? toHash(p) : ""
}

/**
 * The reader's place, so a refresh, a crash or a copied link lands on the same words:
 * `#slide=N` (1-based) on a deck, `#at=<anchor>` on a document (an element with an id,
 * or a source stamp, and how far past its top the view starts — the frame's
 * `positionNow`). A link carries it in its hash; while reading it lives in this tab's
 * session storage, never the URL: the router hooks history.replaceState, so rewriting
 * the URL as the reader scrolls re-ran routing and re-rendered the page on every pause.
 * A link's hash is taken on the first load and then dropped, so a later refresh lands
 * where the reader got to, not back at the link's place.
 */
export function useUrlPlace(shortId: string) {
  const fresh = () => {
    const fromLink = typeof window === "undefined" ? null : parse(window.location.hash)
    const fromTab = !fromLink && reloaded ? load(shortId) : null
    // A place left from an earlier visit is not where this one is.
    live.delete(shortId)
    return {
      key: shortId,
      slide: null as number | null,
      at: "",
      first: fromLink ?? fromTab,
      fromLink: !!fromLink,
      // Until the first load is handed its place back, nothing is saved: with a place to
      // restore (`first`), reports describe where the page happened to start and are
      // dropped; without one they are the reader's (a Next before the load event) and
      // are kept, to be saved at restore.
      live: false,
    }
  }
  const place = useRef<ReturnType<typeof fresh> | null>(null)
  if (place.current?.key !== shortId) place.current = fresh()
  const write = () => {
    const p = place.current
    if (!p) return
    const now = { slide: p.slide, at: p.at }
    live.set(shortId, now)
    save(shortId, now)
  }
  return {
    onPosition: (at: string) => {
      const p = place.current
      if (!p || p.first) return
      p.at = at
      if (p.live && p.slide === null) write()
    },
    onSlide: (i: number) => {
      const p = place.current
      if (!p || p.first) return
      p.slide = i
      if (p.live) write()
    },
    /** The place a frame that just loaded should go to. */
    restore: (): Place => {
      const p = place.current as ReturnType<typeof fresh>
      const to = p.first ?? { slide: p.slide, at: p.at }
      p.first = null
      p.live = true
      reloaded = false
      if (p.fromLink) {
        p.fromLink = false
        const { pathname, search, hash } = window.location
        // history.state is the router's; keep it.
        if (parse(hash))
          window.history.replaceState(window.history.state, "", `${pathname}${search}`)
      }
      if (to.slide !== null || to.at) live.set(shortId, to)
      write()
      return to
    },
    current: (): Place => ({ slide: place.current?.slide ?? null, at: place.current?.at ?? "" }),
  }
}
