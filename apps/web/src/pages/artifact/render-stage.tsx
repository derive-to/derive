import { type ReactNode, type RefObject, useEffect, useState } from "react"
import { Icon } from "@/components/icons"
import { Spinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// How long we wait for the sandboxed render to fire `load` before calling it a
// failed boot. A cache-warm artifact paints in well under a second; this only
// catches a genuinely stuck/broken render so the viewer never stares at a blank
// white frame (NN/g #1 — visibility of system status; the render's own failure
// must be legible, not indistinguishable from "still loading").
const BOOT_TIMEOUT_MS = 15_000

/**
 * The render stage — the artifact is the hero, framed as a matted object floating
 * on the workbench canvas (research: "the render is the hero; full-bleed inside a
 * matted panel"). The panel is a rounded, hairline-outlined white surface
 * (`outline-foreground/10`, no border — the images rule) with a soft shadow in
 * light / just the surface step + outline in dark. Boot and failure are explicit
 * states rendered INSIDE the mat so the frame's geometry never jumps.
 *
 * The frame/wrapper refs are owned by the page (the postMessage bridge + fullscreen
 * drive them) and passed in. `overlays` (deck bar, cursor layer, past-version
 * banner) mount inside the mat in later phases.
 */
export function RenderStage({
  rawSrc,
  title,
  frameRef,
  wrapRef,
  onFrameLoad,
  banner,
  overlays,
  bare,
  className,
}: {
  rawSrc: string
  title: string
  frameRef: RefObject<HTMLIFrameElement | null>
  /** The fullscreen/present target — the mat itself. */
  wrapRef: RefObject<HTMLDivElement | null>
  /** Called on the iframe's own `load` (the page's bridge handshakes off it). */
  onFrameLoad?: () => void
  /** A strip above the render (the past-version banner). */
  banner?: ReactNode
  /** Absolutely-positioned children inside the mat (deck bar, cursor overlay). */
  overlays?: ReactNode
  /** Full-bleed, no mat gap (mobile / focus mode want max render area). */
  bare?: boolean
  className?: string
}) {
  // Boot/failure state is per-source: a new rawSrc (version swap, retry) resets it.
  const [phase, setPhase] = useState<"booting" | "ready" | "failed">("booting")
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    setPhase("booting")
  }, [])

  // Arm the stuck-boot timeout while booting; clear it the moment the frame loads.
  useEffect(() => {
    if (phase !== "booting") return
    const t = setTimeout(() => setPhase("failed"), BOOT_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [phase])

  const handleLoad = () => {
    setPhase("ready")
    onFrameLoad?.()
  }
  const retry = () => {
    setPhase("booting")
    setAttempt((n) => n + 1)
  }

  return (
    <div
      className={cn(
        "relative flex min-h-0 flex-1 flex-col",
        // The mat gap: the framed render floats on the workbench canvas on desktop;
        // full-bleed on phones / focus mode where every pixel of render counts.
        bare ? "p-0" : "p-0 sm:p-3",
        className,
      )}
    >
      {banner}
      <div
        ref={wrapRef}
        className={cn(
          "relative flex min-h-0 flex-1 flex-col overflow-hidden bg-white outline-1 -outline-offset-1 outline-foreground/10",
          // Framed as a matted object off the canvas; dark drops the shadow (the
          // surface step + outline carry it), matching the elevation rules.
          bare ? "rounded-none outline-0" : "rounded-xl shadow-[var(--shadow)]",
        )}
      >
        <iframe
          key={attempt}
          ref={frameRef}
          onLoad={handleLoad}
          title={title}
          src={rawSrc}
          allow="fullscreen"
          // touch-action: pan-y lets the outer page scroll instead of the iframe
          // trapping the gesture on a phone (research's scroll-trap fix); the frame
          // opts into its own pan only inside an explicit zoom mode.
          sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
          className="min-h-0 flex-1 touch-pan-y border-0 bg-white"
        />

        {/* Boot — a calm centered spinner over the white canvas until the render's
            own `load` fires. Announced politely; not a full skeleton because the
            artifact's shape is unknowable. */}
        {phase === "booting" && (
          <div
            role="status"
            aria-live="polite"
            className="absolute inset-0 grid place-items-center bg-white"
          >
            <div className="flex flex-col items-center gap-3">
              <Spinner />
              <span className="font-mono text-2xs text-muted-foreground">Loading preview…</span>
            </div>
          </div>
        )}

        {/* Failure — an explicit terminal state with Retry, never a blank frame. */}
        {phase === "failed" && (
          <div className="absolute inset-0 grid place-items-center bg-background p-6">
            <StatusPanel
              tone="danger"
              icon={<Icon name="removed" strokeWidth={1.75} />}
              title="Preview didn’t load"
              description="The render took too long or failed to start. This is usually temporary."
              className="max-w-sm"
              action={
                <Button variant="outline" data-testid="render-retry" onClick={retry}>
                  Retry
                </Button>
              }
            />
          </div>
        )}

        {overlays}
      </div>
    </div>
  )
}
