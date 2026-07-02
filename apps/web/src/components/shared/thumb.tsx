import { API_BASE } from "@/api"

// A live, scaled-down render of an artifact's current version. Sandboxed and
// non-interactive (clicks fall through to the enclosing card); lazy so off-screen
// cards don't fetch. The token gradient shows through until the frame paints.
// Full-bleed: the enclosing card clips the top corners (overflow-hidden) and owns
// the hover response (lift + shadow), so the frame reads as the artifact itself.
//
// Optional on-render placards (format + version depth) ride at the bottom, scrim-
// backed so they read over any screenshot and non-interactive so a click still
// reaches the card's stretched link.
export function Thumb({
  id,
  v,
  typeLabel,
  version,
}: {
  id: string
  v: number
  typeLabel?: string
  version?: number
}) {
  return (
    // Renders never get borders — the frame is an inset hairline outline (paints
    // above the iframe, per the images/thumbnails doctrine).
    <div className="relative aspect-[16/10] overflow-hidden bg-linear-to-br from-accent to-secondary outline-1 -outline-offset-1 outline-foreground/10">
      <iframe
        title="Preview"
        aria-hidden
        tabIndex={-1}
        loading="lazy"
        src={`${API_BASE}/raw/${id}/v/${v}/index.html`}
        sandbox="allow-scripts"
        // A light-screened render glares on the dark card at rest; a small brightness/
        // saturation dim calms it, then clears on card hover so the preview "wakes".
        // Filter (not transform) so the iframe never repaints — matches the card's
        // shadow-only hover discipline.
        className="pointer-events-none absolute left-0 top-0 h-[250%] w-[250%] origin-top-left scale-[0.4] border-0 bg-white brightness-[0.94] saturate-[0.96] transition-[filter] duration-200 group-hover:brightness-100 group-hover:saturate-100"
      />
      {(typeLabel || version !== undefined) && (
        // Placards ride on the render, so they use the fixed scrim at 85% (dark + light
        // ink, both themes) — placard legibility over arbitrary screenshots is
        // non-negotiable — with a faint ring so they still read on a dark render.
        // Non-interactive.
        <div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex items-center justify-between gap-2">
          {typeLabel && (
            <span className="rounded-md bg-scrim/85 px-1.5 py-0.5 font-mono text-2xs uppercase tracking-wide text-scrim-foreground ring-1 ring-scrim-foreground/15">
              {typeLabel}
            </span>
          )}
          {version !== undefined && (
            <span className="ml-auto rounded-md bg-scrim/85 px-1.5 py-0.5 font-mono text-2xs tabular-nums tracking-wide text-scrim-foreground ring-1 ring-scrim-foreground/15">
              v{version}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
