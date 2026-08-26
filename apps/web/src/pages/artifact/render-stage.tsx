import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react"
import { Icon } from "@/components/icons"
import { Spinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  type ArtifactRuntimeError,
  type ArtifactRuntimeErrorCode,
  isBlockingRuntimeError,
} from "./types"

// How long we wait for the sandboxed render to report meaningful content before
// calling it a failed boot. A cache-warm artifact paints in well under a second; this only
// catches a genuinely stuck/broken render so the viewer never stares at a blank
// white frame (NN/g #1 — visibility of system status; the render's own failure
// must be legible, not indistinguishable from "still loading").
const BOOT_TIMEOUT_MS = 15_000

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

/** Public copy stays source-free; editors get the one actionable repair for the
 * storage case. The runtime sends only this coarse code, never exception text. */
export type RuntimeDisposition = "blocked" | "degraded"

/** Resource failures are optional by default. Script/storage failures block only
 * before meaningful content exists; after ready they degrade without replacing the
 * last good frame. This is the viewer's small, explicit startup state machine. */
export const runtimeDisposition = (error: ArtifactRuntimeError): RuntimeDisposition =>
  isBlockingRuntimeError(error) ? "blocked" : "degraded"

export const runtimeFailureCopy = (
  code: ArtifactRuntimeErrorCode,
  disposition: RuntimeDisposition,
  canFix: boolean,
): { title: string; description: string } => {
  if (disposition === "degraded")
    return canFix
      ? {
          title: "Preview kept running after an artifact error",
          description:
            code === "resource-error"
              ? "An optional image, font, or stylesheet failed to load. The rendered content is still available."
              : "A script failed after meaningful content appeared. The rendered content is still available; check the source before republishing.",
        }
      : {
          title: "Some preview features may be unavailable",
          description:
            "The artifact is still visible. You can retry if something looks incomplete.",
        }
  if (code === "sandbox-storage")
    return canFix
      ? {
          title: "Browser storage isn’t available here",
          description:
            "Derive artifacts run in a secure sandbox without localStorage, sessionStorage, IndexedDB, or cookies. Use derive.shared or in-memory state, then republish.",
        }
      : {
          title: "This artifact couldn’t start",
          description: "Its author needs to update it for Derive’s secure sandbox.",
        }
  return canFix
    ? {
        title: "Artifact script stopped",
        description:
          "A script failed before the artifact finished loading. Check the source and republish.",
      }
    : {
        title: "This artifact couldn’t start",
        description: "Its author needs to fix a script error.",
      }
}

export function RenderStage({
  rawSrc,
  title,
  subject,
  version,
  frameRef,
  wrapRef,
  onFrameLoad,
  runtimeError,
  runtimeReady = false,
  canFixRuntimeError = false,
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
  /** A source-free boot failure relayed by the first-injected sandbox runtime. */
  runtimeError?: ArtifactRuntimeError | null
  /** The injected runtime found meaningful content, not merely an iframe load. */
  runtimeReady?: boolean
  /** Editors get repair guidance; readers see a neutral failure. */
  canFixRuntimeError?: boolean
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: rawSrc identifies a new iframe document and intentionally resets its startup state.
  useEffect(() => {
    setPhase("booting")
  }, [rawSrc])

  useEffect(() => {
    if (runtimeReady) setPhase("ready")
  }, [runtimeReady])

  // Arm the stuck-boot timeout while booting; clear it only after meaningful paint.
  // No src yet means no load in flight — don't count seed-wait time against the render.
  useEffect(() => {
    // A specific blocking runtime error already owns recovery. Do not let the
    // generic timeout later mount a second, overlapping Try again control.
    if (
      phase !== "booting" ||
      rawSrc == null ||
      (runtimeError && isBlockingRuntimeError(runtimeError))
    )
      return
    const t = setTimeout(() => setPhase("failed"), BOOT_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [phase, rawSrc, runtimeError])

  const handleLoad = () => {
    onFrameLoad?.()
  }
  const retry = () => {
    setPhase("booting")
    setAttempt((n) => n + 1)
  }
  const disposition = runtimeError ? runtimeDisposition(runtimeError) : null
  const runtimeFailure = runtimeError
    ? runtimeFailureCopy(runtimeError.code, disposition ?? "blocked", canFixRuntimeError)
    : null
  const incidentReference = runtimeError
    ? `${subject}${version == null ? "" : `-v${version}`}-${runtimeError.code}`
    : null
  const incidentInstance = incidentReference ? `${incidentReference}-${attempt}` : null
  const [dismissedIncident, setDismissedIncident] = useState<string | null>(null)

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
      {/* A warning must never obscure authored content. Keep degraded recovery in
          the stage flow, outside the iframe/cursor coordinate system. */}
      {phase === "ready" &&
        runtimeFailure &&
        disposition === "degraded" &&
        incidentInstance !== dismissedIncident && (
          <div
            role="status"
            aria-live="polite"
            data-testid="render-degraded"
            className="flex shrink-0 items-center gap-3 border-b border-warning/30 bg-card px-3 py-2"
          >
            <Icon name="report" className="size-4 shrink-0 text-warning" strokeWidth={1.75} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">{runtimeFailure.title}</p>
              <p className="hidden text-xs text-muted-foreground sm:block">
                {runtimeFailure.description}
              </p>
              <p className="mt-0.5 hidden font-mono text-3xs text-muted-foreground sm:block">
                Reference: {incidentReference}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="outline" size="sm" data-testid="render-retry" onClick={retry}>
                Try again
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Dismiss preview warning"
                data-testid="render-degraded-dismiss"
                onClick={() => setDismissedIncident(incidentInstance)}
              >
                <Icon name="close" size={14} />
              </Button>
            </div>
          </div>
        )}
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
              <span className="font-mono text-2xs text-muted-foreground">Loading preview…</span>
            </div>
          </div>
        )}

        {/* Failure — an explicit terminal state with Retry, never a blank frame. */}
        {phase === "failed" && disposition !== "blocked" && (
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

        {/* The iframe can load successfully while an authored script fails during
            first render. The early runtime relay makes that terminal state explicit
            instead of leaving the artifact's own loading copy on screen forever. */}
        {runtimeFailure && disposition === "blocked" && (
          <div className="absolute inset-0 z-20 grid place-items-center bg-background p-6">
            <StatusPanel
              tone="danger"
              icon={<Icon name="removed" strokeWidth={1.75} />}
              title={runtimeFailure.title}
              description={runtimeFailure.description}
              className="max-w-md"
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
