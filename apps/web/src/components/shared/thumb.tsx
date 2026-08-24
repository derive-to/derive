import { useEffect, useRef, useState } from "react"
import { API_BASE } from "@/api"
import { cn } from "@/lib/utils"
import { thumbMedia } from "./thumb-media"

// A live, scaled-down render of an artifact's current version — the hero of every
// artifact card. Sandboxed and non-interactive (clicks fall through to the
// enclosing card); lazy so off-screen cards don't fetch, and the virtualized grid
// keeps only near-viewport rows mounted. The token gradient shows through until
// the frame paints. The enclosing card owns clipping/rounding.
//
// Resting-dim → hover-wake: the render sits slightly knocked-back at rest (a light
// page glares on the wall of cards) and clears to full on the card's hover/focus.
// A `filter` (not `transform`) so the iframe never repaints — a translating iframe
// visibly flashes, which is why cards never lift.
//
// One machine-register placard rides the bottom-left over a fixed scrim (legible
// over any screenshot, both themes): the artifact's type — `HTML`. The version and
// freshness live in the card's caption state line, so the placard stays a single
// category tag over the render.
export function Thumb({
  id,
  v,
  typeLabel,
  hasPreview,
  className,
}: {
  id: string
  v: number
  typeLabel?: string
  /** When true, render the static PNG from /v1/og/:id instead of the live iframe. */
  hasPreview?: boolean
  className?: string
}) {
  // The frame fades up once it paints, so a blank white iframe never pops over the
  // deterministic document underlay. The underlay stays STATIC (no breath) — a wall
  // of thumbnails must read calm. The opacity rides the same duration-state declaration
  // as the hover filter-wake (one transition covering both).
  const mediaKey = `${id}:${v}:${hasPreview ? "preview" : "live"}`
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  // If the static PNG fails to load (e.g. signed-out viewer, key mismatch), fall
  // back to the live iframe so the card never shows a broken image slot.
  const [failedKey, setFailedKey] = useState<string | null>(null)
  // Key readiness to the artifact version. A republish can update this component in
  // place; the underlay returns until the new version paints, with no stale preview flash.
  const loaded = loadedKey === mediaKey
  const imgFailed = failedKey === mediaKey
  const imgRef = useRef<HTMLImageElement>(null)

  // Cached images may finish before React attaches `onLoad` (the production failure
  // that left Zero Prime's fully-downloaded 1200x630 previews at opacity: 0). Checking
  // the DOM image after mount closes that event race; a genuine failed image still
  // takes the existing live-iframe recovery path.
  useEffect(() => {
    if (!hasPreview || imgFailed) return
    const image = imgRef.current
    if (!image?.complete) return
    if (image.naturalWidth > 0) {
      setLoadedKey(mediaKey)
      return
    }
    setFailedKey(mediaKey)
  }, [hasPreview, imgFailed, mediaKey])

  return (
    <div
      className={cn(
        "relative aspect-[16/10] overflow-hidden bg-muted outline-1 -outline-offset-1 outline-foreground/10 group-hover:outline-foreground/20 group-focus-within:outline-foreground/20",
        className,
      )}
    >
      {/* Always rendered beneath the rich media. Slow, cached-race, failed-image, and
          failed-frame states all retain a deliberate thumbnail instead of an empty slab. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 grid place-items-center bg-gradient-to-br from-muted via-card to-secondary"
      >
        <div className="w-[34%] rounded-md border border-border bg-card/80 p-3 shadow-sm">
          <div className="h-1 w-2/3 rounded-full bg-muted-foreground/30" />
          <div className="mt-2 h-1 w-full rounded-full bg-muted-foreground/20" />
          <div className="mt-1.5 h-1 w-5/6 rounded-full bg-muted-foreground/20" />
          <div className="mt-1.5 h-1 w-3/5 rounded-full bg-muted-foreground/20" />
        </div>
      </div>
      {thumbMedia(hasPreview, imgFailed) === "img" ? (
        <img
          ref={imgRef}
          // Keyed by version so a republish busts the browser's cached screenshot
          // of the previous one (the og route serves long max-age per URL).
          src={`${API_BASE}/v1/og/${id}?v=${v}`}
          alt=""
          aria-hidden
          loading="lazy"
          onLoad={() => setLoadedKey(mediaKey)}
          onError={() => {
            setFailedKey(mediaKey)
            setLoadedKey(null)
          }}
          className={cn(
            "absolute inset-0 h-full w-full object-cover brightness-[0.96] saturate-[0.98] transition-[opacity,filter] duration-state group-hover:brightness-100 group-hover:saturate-100 group-focus-within:brightness-100 group-focus-within:saturate-100",
            loaded ? "opacity-100" : "opacity-0",
          )}
        />
      ) : (
        <iframe
          title="Preview"
          aria-hidden
          tabIndex={-1}
          loading="lazy"
          onLoad={() => setLoadedKey(mediaKey)}
          src={`${API_BASE}/raw/${id}/v/${v}/index.html`}
          sandbox="allow-scripts"
          className={cn(
            "pointer-events-none absolute left-0 top-0 h-[250%] w-[250%] origin-top-left scale-[0.4] border-0 bg-white brightness-[0.96] saturate-[0.98] transition-[opacity,filter] duration-state group-hover:brightness-100 group-hover:saturate-100 group-focus-within:brightness-100 group-focus-within:saturate-100",
            loaded ? "opacity-100" : "opacity-0",
          )}
        />
      )}
      {typeLabel && (
        <span className="pointer-events-none absolute bottom-2 left-2 z-10 rounded-md bg-scrim/85 px-1.5 py-0.5 font-mono text-2xs uppercase tracking-wide text-scrim-foreground ring-1 ring-scrim-foreground/15">
          {typeLabel}
        </span>
      )}
    </div>
  )
}
