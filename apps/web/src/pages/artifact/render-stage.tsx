import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react"
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
/** Total boot tries before the stage goes terminal-failed (initial + auto-retries). */
export const BOOT_MAX_TRIES = 3

/**
 * Pure decision after a boot timeout at `tryIndex` (0-based). Retries with growing
 * backoff while tries remain; only the last exhaustion is terminal. Extracted so the
 * sequence is pinned by tests — the viewer should keep waiting on a slow server-side
 * render instead of forcing a manual Retry at 15s.
 */
export const bootTimeoutDecision = (
  tryIndex: number,
): { action: "retry"; delayMs: number } | { action: "fail" } => {
  if (tryIndex + 1 >= BOOT_MAX_TRIES) return { action: "fail" }
  // 1s, then 2s — short enough to feel alive, long enough for the render to land.
  return { action: "retry", delayMs: 1_000 * 2 ** tryIndex }
}

/** Waiting-state copy: first try is calm; after a timeout/retry we name the wait. */
export const bootStatusCopy = (tryIndex: number, awaitingRetry: boolean): string =>
  tryIndex > 0 || awaitingRetry ? "Still rendering…" : "Loading preview…"

/**
 * The render stage — the artifact is the hero. The sandboxed iframe fills the stage
 * edge-to-edge (research: "the render is the hero; the iframe fills the panel
 * edge-to-edge, zero internal padding"), framed by the workbench header above it and
 * clipped to the content card's rounded corners (the shell's SidebarInset is
 * `overflow-hidden rounded-xl`). NO mat gap: an artifact carries its own background,
 * which can be any color, so a gap would frame a dark artifact in an awkward light
 * border. Boot + failure are explicit states rendered inside so geometry never jumps.
 *
 * The frame/wrapper refs are owned by the page (the postMessage bridge + fullscreen
 * drive them) and passed in. `overlays` (deck bar, cursor layer) mount inside.
 */

/** What the Updated cue remembers between renders: which document, at which version. */
export type UpdateCueState = { subject: string; version: number } | null

/**
 * Pure decision for the soft "Updated · vN" cue. Fires ONLY when the SAME subject
 * steps up in place — never on first sight of a document, never when navigation swaps
 * the subject (that is a different document, not an update), never on stepping back
 * to an older version.
 */
export const updateCue = (
  prev: UpdateCueState,
  subject: string,
  version: number | undefined,
): { fire: number | null; state: UpdateCueState } => {
  // Source not known yet: keep the baseline only if it's still the same document.
  if (version == null) return { fire: null, state: prev && prev.subject === subject ? prev : null }
  const same = prev && prev.subject === subject
  // The baseline is the HIGHEST version seen of this subject, not the last one shown:
  // stepping back to v2 and returning to v3 is navigation, and firing on the return
  // was the same phantom one level down.
  const state = { subject, version: same ? Math.max(prev.version, version) : version }
  if (!same || version <= prev.version) return { fire: null, state }
  return { fire: version, state }
}

export function RenderStage({
  rawSrc,
  title,
  subject,
  version,
  frameRef,
  wrapRef,
  onFrameLoad,
  banner,
  overlays,
  overlay = false,
  presenting = false,
  className,
}: {
  /** null = the source isn't known yet (the record is still a list-row seed) — the
   *  boot state shows without an iframe, and the frame mounts when the src lands. */
  rawSrc: string | null
  title: string
  /** WHOSE render this is (the artifact's short id). The Updated cue is keyed on it —
   *  the stage stays mounted across sibling navigation, and a version number alone
   *  can't tell "this document gained a version" from "I'm looking at a different
   *  document now". */
  subject: string
  /** The shown version — when it steps UP (a new version published in place), a
   *  soft "Updated" badge flashes over the render (research: auto-swap + soft cue). */
  version?: number
  frameRef: RefObject<HTMLIFrameElement | null>
  /** The fullscreen/present target — the render surface itself. */
  wrapRef: RefObject<HTMLDivElement | null>
  /** Called on the iframe's own `load` (the page's bridge handshakes off it). */
  onFrameLoad?: () => void
  /** A strip above the render (the past-version banner). */
  banner?: ReactNode
  /** Absolutely-positioned children inside the render (deck bar, cursor overlay). */
  overlays?: ReactNode
  /** Present mode without the Fullscreen API — the stage covers the viewport itself. */
  overlay?: boolean
  /** Present mode (either path): the controls get a strip of their own — see below. */
  presenting?: boolean
  className?: string
}) {
  // Boot/failure state is per-source: a new rawSrc (version swap, retry) resets it.
  const [phase, setPhase] = useState<"booting" | "ready" | "failed">("booting")
  const [attempt, setAttempt] = useState(0)
  // 0-based try within the current boot cycle — independent of the iframe mount key so
  // a manual Retry after terminal failure can re-arm the full auto-retry budget.
  const [bootTry, setBootTry] = useState(0)
  // True between a timed-out boot and the backoff-driven remount (copy flips here).
  const [awaitingRetry, setAwaitingRetry] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: rawSrc is an intentional reset trigger (version swap / new src); body only flips local boot state.
  useEffect(() => {
    setPhase("booting")
    setBootTry(0)
    setAwaitingRetry(false)
  }, [rawSrc])

  // Arm the stuck-boot timeout while booting; clear it the moment the frame loads.
  // No src yet means no load in flight — don't count seed-wait time against the render.
  // On timeout: auto-retry with backoff a few times (slow server-side render is common
  // right after publish); only exhaust into terminal failed after BOOT_MAX_TRIES.
  useEffect(() => {
    if (phase !== "booting" || rawSrc == null) return
    let cancelled = false
    let backoffId: ReturnType<typeof setTimeout> | undefined
    const bootId = setTimeout(() => {
      const decision = bootTimeoutDecision(bootTry)
      if (decision.action === "fail") {
        setPhase("failed")
        setAwaitingRetry(false)
        return
      }
      setAwaitingRetry(true)
      backoffId = setTimeout(() => {
        if (cancelled) return
        setAwaitingRetry(false)
        setBootTry((n) => n + 1)
        setAttempt((n) => n + 1)
      }, decision.delayMs)
    }, BOOT_TIMEOUT_MS)
    return () => {
      cancelled = true
      clearTimeout(bootId)
      if (backoffId !== undefined) clearTimeout(backoffId)
    }
  }, [phase, rawSrc, bootTry])

  const handleLoad = () => {
    setPhase("ready")
    setAwaitingRetry(false)
    onFrameLoad?.()
  }
  const retry = () => {
    setPhase("booting")
    setBootTry(0)
    setAwaitingRetry(false)
    setAttempt((n) => n + 1)
  }

  // "Updated" cue: when the shown version steps up IN PLACE (a peer published a new
  // version of the document being watched), flash a soft, non-blocking badge instead
  // of jolting the viewer (research: soft cue, never a modal). Keyed by SUBJECT, not
  // just number: this component stays mounted while the sibling switcher pages
  // between artifacts, and a bare version comparison read "memo v1 → sibling v5" as
  // "someone just published v5" — a phantom Updated pill floating over a document
  // nobody touched. The decision is pure (updateCue) and pinned by tests.
  const cueRef = useRef<UpdateCueState>(null)
  const [updatedTo, setUpdatedTo] = useState<number | null>(null)
  useEffect(() => {
    const prev = cueRef.current
    const { fire, state } = updateCue(prev, subject, version)
    cueRef.current = state
    if (fire != null) {
      setUpdatedTo(fire)
      const t = setTimeout(() => setUpdatedTo(null), 3500)
      return () => clearTimeout(t)
    }
    // Paging away mid-flash: the pill was about the OLD document; it must not ride
    // into the new one.
    if (prev && prev.subject !== subject) setUpdatedTo(null)
  }, [subject, version])

  return (
    <div className={cn("relative flex min-h-0 flex-1 flex-col", className)}>
      {banner}
      {/* The render fills edge-to-edge; the content card's rounded overflow-hidden
          clips it, and the header above carries its top edge. bg-background (the app
          canvas, NEVER bg-white) is the backdrop the boot state paints on — so a dark
          artifact never flashes a white rectangle before it takes over. */}
      <div
        ref={wrapRef}
        data-presenting={overlay || undefined}
        className={cn(
          "relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background",
          // Presenting where the Fullscreen API isn't available (iOS Safari refuses
          // it for anything but a video): the stage takes the viewport itself. Same
          // result, one z-index instead of a capability we don't have.
          overlay && "fixed inset-0 z-70",
          // The controls get a strip of their OWN while presenting, instead of
          // floating over the last few pixels of the slide.
          //
          // A deck sizes itself to the viewport it is handed and puts its own
          // furniture — page number, progress bar, "← → to navigate" — along the
          // bottom edge. Handed the entire screen, a 16:9 deck's stage grows until
          // that furniture is jammed against the slide (measured: 24px of clearance
          // at 1440×810), and our bar then lands on top of the same 24px. Two sets of
          // controls, one strip, and a bottom edge that reads crowded and heavier
          // than the top.
          //
          // Reserving the strip costs ~56px of stage. The deck re-fits into what's
          // left and re-centres itself, so its own furniture gets room AND the slide
          // sits evenly between top and bar. The bar is absolutely positioned against
          // the padding box, so it lands in the strip without moving.
          //
          // Black rather than the app canvas: the strip sits directly under a deck
          // painting its own backdrop, and two near-black tones meeting read as a
          // rendering seam. Black reads as letterbox, which is what it is.
          presenting && "bg-black pb-14",
        )}
      >
        {rawSrc != null && (
          <iframe
            key={attempt}
            ref={frameRef}
            onLoad={handleLoad}
            title={title}
            src={rawSrc}
            allow="fullscreen"
            // touch-action: pan-y lets the outer page scroll instead of the iframe
            // trapping the gesture on a phone (research's scroll-trap fix); the frame
            // opts into its own pan only inside an explicit zoom mode. The iframe keeps
            // its own bg-white (the right default for a transparent HTML doc) but starts
            // hidden and cross-fades in on load, so the white→content swap resolves
            // gently over the neutral canvas instead of hard-flashing.
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
            className={cn(
              "min-h-0 flex-1 touch-pan-y border-0 bg-white opacity-0 transition-opacity duration-state",
              phase === "ready" && "opacity-100",
            )}
          />
        )}

        {/* Boot — a calm centered spinner over the white canvas until the render's
            own `load` fires. Announced politely; not a full skeleton because the
            artifact's shape is unknowable. */}
        {phase === "booting" && (
          <div
            role="status"
            aria-live="polite"
            className="absolute inset-0 grid place-items-center bg-background"
          >
            <div className="flex flex-col items-center gap-3">
              {/* Decorative: the wrapping div is the live region (aria-live) with the
                  visible label, so the spinner must not announce a second time. */}
              <Spinner size="lg" role="presentation" aria-label={undefined} />
              <span className="font-mono text-2xs text-muted-foreground">
                {bootStatusCopy(bootTry, awaitingRetry)}
              </span>
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
                  Try again
                </Button>
              }
            />
          </div>
        )}

        {/* Soft "updated in place" cue after a new version auto-swaps in. Announced
            politely so a screen-reader viewer hears the swap too — matching the boot
            state's live region (the render's own status must be legible, not silent). */}
        {updatedTo != null && (
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center"
          >
            <span className="animate-in fade-in slide-in-from-top-1 rounded-full bg-card px-3 py-1 font-mono text-2xs text-muted-foreground shadow-[var(--shadow)] ring-1 ring-foreground/10">
              Updated · v{updatedTo}
            </span>
          </div>
        )}

        {overlays}
      </div>
    </div>
  )
}
