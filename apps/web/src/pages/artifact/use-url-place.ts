import { useRef } from "react"

type Place = { slide: number | null; at: string }

const parse = (hash: string): Place | null => {
  const slide = /^#slide=(\d+)$/.exec(hash)
  if (slide) return { slide: Math.max(0, Number(slide[1]) - 1), at: "" }
  const at = /^#at=(.+)$/.exec(hash)
  return at?.[1] ? { slide: null, at: at[1].slice(0, 300) } : null
}

/**
 * The reader's place, kept in the URL so a refresh, a shared link or a crash lands on
 * the same words: `#slide=N` (1-based) on a deck, `#at=<anchor>` on a document (an
 * element with an id, or a source stamp, and how far past its top the view starts —
 * the frame's `positionNow`). The frame reports as the reader moves; each load of the
 * frame is handed the place back: the URL's on the first load, the current one after.
 */
export function useUrlPlace(shortId: string) {
  const fresh = () => ({
    key: shortId,
    slide: null as number | null,
    at: "",
    first: typeof window === "undefined" ? null : parse(window.location.hash),
    // Reports before the first load's place is handed back describe where the page
    // happened to start, not where the reader is: they don't overwrite the URL.
    live: false,
  })
  const place = useRef(fresh())
  if (place.current.key !== shortId) place.current = fresh()
  const write = () => {
    const p = place.current
    const hash = p.slide !== null ? `#slide=${p.slide + 1}` : p.at ? `#at=${p.at}` : ""
    if (window.location.hash === hash || (!hash && !window.location.hash)) return
    const { pathname, search } = window.location
    // history.state is the router's; keep it.
    window.history.replaceState(window.history.state, "", `${pathname}${search}${hash}`)
  }
  return {
    onPosition: (at: string) => {
      const p = place.current
      if (!p.live) return
      p.at = at
      if (p.slide === null) write()
    },
    onSlide: (i: number) => {
      const p = place.current
      if (!p.live) return
      p.slide = i
      write()
    },
    /** The place a frame that just loaded should go to. */
    restore: (): Place => {
      const p = place.current
      const to = p.first ?? { slide: p.slide, at: p.at }
      p.first = null
      p.live = true
      return to
    },
    current: (): Place => ({ slide: place.current.slide, at: place.current.at }),
  }
}
