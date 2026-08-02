import { useState } from "react"
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
  // neutral placeholder. The placeholder itself stays STATIC (a plain bg-muted, no
  // breath) — a wall of thumbnails must read calm. The opacity rides the same
  // duration-state declaration as the hover filter-wake (one transition covering both).
  const [loaded, setLoaded] = useState(false)
  // If the static PNG fails to load (e.g. signed-out viewer, key mismatch), fall
  // back to the live iframe so the card never shows a broken image slot.
  const [imgFailed, setImgFailed] = useState(false)
  return (
    <div
      className={cn(
        "relative aspect-[16/10] overflow-hidden bg-muted outline-1 -outline-offset-1 outline-foreground/10 group-hover:outline-foreground/20 group-focus-within:outline-foreground/20",
        className,
      )}
    >
      {thumbMedia(hasPreview, imgFailed) === "img" ? (
        <img
          // Keyed by version so a republish busts the browser's cached screenshot
          // of the previous one (the og route serves long max-age per URL).
          src={`${API_BASE}/v1/og/${id}?v=${v}`}
          alt=""
          aria-hidden
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => {
            setImgFailed(true)
            setLoaded(false)
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
          onLoad={() => setLoaded(true)}
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
