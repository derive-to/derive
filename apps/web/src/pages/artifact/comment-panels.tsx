import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react"
import type { Comment, Mention } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { Count } from "@/components/shared/section-eyebrow"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { Composer } from "./comment-composer"
import { CollapsibleThreadSection, CommentCard, PinnedZone } from "./comment-thread"
import { useCommentScope } from "./lib/comment-scope"
import { CommentTreeProvider, useCommentTree } from "./lib/comment-tree"
import { type ComposerState, type FrameGeom, type PinItem, selLabel } from "./types"

// Touch has no hover, so the mobile sheet overrides the tree's onHover with this.
const NO_HOVER = () => {}

// A one-line plain-text teaser of a comment body for the peek preview (CSS truncates
// the length; this just flattens whitespace so a multi-line body reads as one line).
const teaser = (md: string) => md.replace(/\s+/g, " ").trim()

// The comments panel header: the label + the open-thread count in the machine
// count register ("Comments · 3") — quieter than a pill blob beside the title.
function CommentsHeading({ count }: { count: number }) {
  return (
    <div className="flex min-w-0 flex-1 items-baseline gap-1 pl-1.5">
      <span className="text-sm font-medium text-foreground">Comments</span>
      {count > 0 && <Count>{count}</Count>}
    </div>
  )
}

export function MobileComments({
  open,
  openThreads,
  resolved,
  composer,
  onNewGeneral,
  onSubmitNew,
  onCancelNew,
  onHeightChange,
}: {
  open: boolean
  openThreads: Comment[][]
  resolved: Comment[][]
  composer: ComposerState
  onNewGeneral: () => void
  onSubmitNew: (text: string, mentions?: Mention[]) => void
  onCancelNew: () => void
  reviewCard?: ReactNode
  /** How much of the viewport bottom the sheet currently occupies, in px (0 when
   *  closed). The page reserves exactly this under the document so no black band
   *  is left below it. */
  onHeightChange?: (px: number) => void
}) {
  // The sheet is ALWAYS docked on a phone (peek is the floor — there is no hidden
  // state and no scrim; the doc above stays live). Two resting sizes: peek (the slim
  // bar, one line taller when it can preview the latest comment) and full (the list,
  // content-weighted up to half the screen). Composing overrides both with a compact
  // composer bar pinned above the keyboard (see the height + `kb` style below), so
  // the box sits flush above the keyboard with the document visible above.
  const { canComment } = useCommentScope()
  const tree = useCommentTree()
  const [size, setSize] = useState<"peek" | "full">("peek")
  const sheetRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) setSize("peek")
  }, [open])
  // iOS keeps `position: fixed` put when the keyboard opens, so a bottom sheet hides
  // behind it. Track the keyboard via visualViewport and pin the sheet into the
  // visible area above it. Measure against the layout viewport (clientHeight is
  // keyboard-stable on iOS); a >150px shrink is a real keyboard, which rules out the
  // ~60-115px Safari toolbar collapse that would otherwise false-trigger. rAF-
  // coalesced and change-guarded so the scroll/resize bursts don't thrash.
  const [kb, setKb] = useState<{ inset: number; height: number } | null>(null)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    let raf = 0
    const measure = () => {
      const layoutH = document.documentElement.clientHeight
      const inset = Math.max(0, layoutH - vv.height - vv.offsetTop)
      const next = inset > 150 ? { inset: Math.round(inset), height: Math.round(vv.height) } : null
      setKb((prev) => {
        if (!prev && !next) return prev
        if (prev && next && prev.inset === next.inset && prev.height === next.height) return prev
        return next
      })
    }
    const update = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    }
    measure()
    vv.addEventListener("resize", update)
    vv.addEventListener("scroll", update)
    return () => {
      cancelAnimationFrame(raf)
      vv.removeEventListener("resize", update)
      vv.removeEventListener("scroll", update)
    }
  }, [])
  // When the composer closes (submit/cancel), drop focus so iOS dismisses the
  // keyboard instead of leaving it up over an empty sheet (which would keep the
  // sheet pinned/shrunk via `kb`).
  useEffect(() => {
    if (!composer) (document.activeElement as HTMLElement | null)?.blur?.()
  }, [composer])
  // Report how much of the viewport bottom the sheet occupies so the page can
  // reserve exactly that under the document — no more, no less. A static reserve
  // (the old `pb-[50vh]`) left a tall black band below the document whenever the
  // sheet rested at its slim peek height. Measuring the sheet's top to the layout-
  // viewport bottom folds in every state: the open/close slide (a transform), the
  // peek<->full height change, and the keyboard-pinned composer (its inset is
  // included). A rAF loop while open tracks it frame-accurately (idle cost is one
  // cheap fixed-element rect read per frame); closed reports 0 and stops.
  useEffect(() => {
    if (!open) {
      onHeightChange?.(0)
      return
    }
    let raf = 0
    let last = -1
    const tick = () => {
      const el = sheetRef.current
      if (el) {
        const inset = Math.max(0, Math.round(window.innerHeight - el.getBoundingClientRect().top))
        if (inset !== last) {
          last = inset
          onHeightChange?.(inset)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [open, onHeightChange])
  const empty = openThreads.length === 0 && resolved.length === 0 && !composer
  // The most recent open comment — the peek bar previews it so the resting state
  // teases the live discussion instead of showing a bare "Comments" header.
  const latest = useMemo(() => {
    let best: Comment | null = null
    for (const t of openThreads)
      for (const c of t) if (c.body_md && (!best || c.created_at > best.created_at)) best = c
    return best
  }, [openThreads])
  // The grip (tap) toggles peek <-> expanded.
  const grip = () => {
    if (moved.current) {
      // A drag just ended on this element — the trailing click isn't a tap.
      moved.current = false
      return
    }
    setSize((s) => (s === "peek" ? "full" : "peek"))
  }
  // Jumping to text keeps the sheet where it is: expanded is capped at half the
  // screen, so the highlight always lands visible in the doc strip above. (The old
  // collapse-to-peek was a workaround for the full-screen sheet covering the doc.)
  const jumpToText = (id: string) => tree.onJump(id)
  // The sheet's cards read this overridden tree: touch has no hover (so no emphasis
  // state) — everything else is the page's tree.
  const sheetTree = { ...tree, hoverThread: null, onHover: NO_HOVER, onJump: jumpToText }

  // --- drag: the grip/header drags between the two resting sizes -----------------
  // Feedback is a direct `translate` style write per move (no re-render, transition
  // suspended); release restores the class transition so the settle animates, and
  // only a past-threshold drag (or a fling) flips the size. Peek is the FLOOR —
  // dragging down from peek rubber-bands instead of dismissing (the docked bar is
  // the comments entry point) — and expanded rubber-bands upward past its cap.
  // Disabled while the keyboard owns the sheet's position (kb) or while composing.
  const drag = useRef<{ y0: number; t0: number; dy: number } | null>(null)
  const moved = useRef(false)
  const dragStart = (e: React.PointerEvent) => {
    if (kb || composer) return
    if ((e.target as HTMLElement).closest("button")) return // buttons keep their taps
    drag.current = { y0: e.clientY, t0: e.timeStamp, dy: 0 }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const el = sheetRef.current
    if (el) el.style.transition = "none"
  }
  const dragMove = (e: React.PointerEvent) => {
    const d = drag.current
    const el = sheetRef.current
    if (!d || !el) return
    d.dy = e.clientY - d.y0
    const resisted =
      size === "peek"
        ? d.dy > 0
          ? d.dy / 4 // floor: resist downward
          : Math.max(d.dy, -96) // follow upward a bit, then the flip takes over
        : d.dy < 0
          ? d.dy / 4 // cap: resist upward
          : d.dy
    el.style.translate = `0 ${resisted}px`
  }
  const dragEnd = (e: React.PointerEvent) => {
    const d = drag.current
    const el = sheetRef.current
    drag.current = null
    if (!d || !el) return
    moved.current = Math.abs(d.dy) > 5
    el.style.transition = ""
    el.style.translate = ""
    const fling = Math.abs(d.dy) / Math.max(1, e.timeStamp - d.t0) > 0.5
    if (size === "peek" && (d.dy < -60 || (fling && d.dy < 0))) setSize("full")
    else if (size === "full" && (d.dy > 60 || (fling && d.dy > 0))) setSize("peek")
  }

  // --- stepper: walk the open threads one at a time ------------------------------
  // Each step scrolls the thread's card into view in the list AND, for an anchored
  // thread, scrolls the document to its highlight — which stays visible because the
  // sheet never exceeds half the screen.
  const [step, setStep] = useState(0)
  const stepIdx = Math.min(step, Math.max(0, openThreads.length - 1))
  const stepTo = (i: number) => {
    const n = openThreads.length
    if (n === 0) return
    const idx = (i + n) % n
    setStep(idx)
    const head = openThreads[idx]?.[0]
    if (!head) return
    sheetRef.current
      ?.querySelector(`[data-thread-id="${head.thread_id}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    if (head.anchor) tree.onJump(head.thread_id)
  }
  return (
    <aside
      ref={sheetRef}
      className={cn(
        // The slide rides the `translate` property (translate-y-full/0), so the
        // transition MUST target `translate` — not `transform` — or the sheet jumps
        // in and out instead of sliding. Height changes snap (auto isn't
        // animatable); the drag handlers suspend/restore this transition inline.
        "fixed inset-x-0 bottom-0 z-61 flex flex-col rounded-t-2xl border-t border-border bg-card shadow-[var(--shadow-pop)] transition-[translate] duration-200 ease-out",
        // Heights are CONTENT-WEIGHTED: composing is a compact bar above the
        // keyboard; expanded hugs its comments up to half the screen (the doc
        // strip above stays visible and live — no reading mode that owns the
        // whole screen); peek is a slim bar, one line taller with a preview.
        composer ? "max-h-[80vh]" : size === "full" ? "max-h-[50vh]" : latest ? "h-24" : "h-18.5",
        open ? "translate-y-0" : "translate-y-full",
      )}
      // While the keyboard is up, lift the sheet's bottom to just above it and cap
      // its height to the visible band — so the half-height composer sits in view
      // (with a sliver of document above) instead of behind/under the keyboard.
      style={kb ? { bottom: kb.inset, maxHeight: kb.height } : undefined}
      // Non-modal by design: the document above stays visible and interactive in
      // every state, so this is an aside, not a dialog (no focus trap, no scrim).
      aria-label="Comments"
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: the grip/header strip is a drag handle (pointer events) with tap-to-toggle; the real controls inside are buttons. */}
      <div
        className="shrink-0 touch-none"
        onPointerDown={dragStart}
        onPointerMove={dragMove}
        onPointerUp={dragEnd}
        onPointerCancel={dragEnd}
      >
        {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: grip toggles the sheet size; keyboard users have the labeled caret button below. */}
        <div
          data-testid="comments-sheet-grip"
          className="flex cursor-grab justify-center pb-1 pt-2"
          onClick={grip}
          title="Resize"
        >
          <div className="h-1 w-10 rounded-full bg-border" />
        </div>
        <div className="flex items-center gap-2 border-b border-border-soft pb-3 pl-3 pr-2.5 pt-2">
          <CommentsHeading count={openThreads.length} />
          {size === "full" && !composer && openThreads.length > 1 && (
            // Step through the discussion one thread at a time: the card scrolls
            // into view and an anchored thread scrolls the doc to its highlight.
            <div className="flex items-center gap-0.5 font-mono text-xs tabular-nums text-muted-foreground">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Previous comment"
                data-testid="comments-step-prev"
                onClick={() => stepTo(stepIdx - 1)}
              >
                <Icon name="caret" className="size-4 rotate-90" />
              </Button>
              {stepIdx + 1}/{openThreads.length}
              <Button
                variant="ghost"
                size="icon"
                aria-label="Next comment"
                data-testid="comments-step-next"
                onClick={() => stepTo(stepIdx + 1)}
              >
                <Icon name="caret" className="size-4 -rotate-90" />
              </Button>
            </div>
          )}
          {canComment && (
            <Button
              variant="outline"
              size="sm"
              data-testid="comments-sheet-new"
              onClick={() => {
                setSize("full")
                onNewGeneral()
              }}
            >
              <Icon name="plus" size={16} />
              New
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label={size === "peek" ? "Expand" : "Collapse"}
            data-testid="comments-sheet-resize"
            onClick={() => setSize(size === "peek" ? "full" : "peek")}
          >
            <Icon name="caret" className={cn("size-4", size === "peek" && "rotate-180")} />
          </Button>
        </div>
      </div>
      {composer ? (
        // Composing ("half open"): just the composer, so the sheet is a compact bar
        // pinned above the keyboard with the document visible above. The list
        // reappears once you send or cancel.
        <div className="overflow-auto p-3 pb-[max(14px,env(safe-area-inset-bottom))]">
          <Composer
            quote={selLabel(composer.anchor)}
            // After posting, open the full list so the new comment is visible (the
            // sheet would otherwise drop back to the peek bar and hide it).
            onSubmit={(text, mentions) => {
              setSize("full")
              onSubmitNew(text, mentions)
            }}
            onCancel={onCancelNew}
          />
        </div>
      ) : size === "full" ? (
        <CommentTreeProvider value={sheetTree}>
          <div className="min-h-0 flex-1 overflow-auto p-3 pb-[max(14px,env(safe-area-inset-bottom))]">
            {empty && (
              <EmptyState
                className="p-8"
                icon={<Icon name="comments" strokeWidth={1.75} />}
                title="Start the conversation."
                description="Select text in the document, or add a general comment."
                action={
                  canComment ? (
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="comments-sheet-empty-new"
                      onClick={() => {
                        setSize("full")
                        onNewGeneral()
                      }}
                    >
                      New comment
                    </Button>
                  ) : undefined
                }
              />
            )}
            {openThreads.map((t) => {
              const head = t[0]
              if (!head) return null
              return (
                <div key={head.thread_id} data-thread-id={head.thread_id} className="mb-2.5">
                  <CommentCard thread={t} />
                </div>
              )
            })}
            {resolved.length > 0 && (
              <CollapsibleThreadSection
                label="Resolved"
                defaultOpen={false}
                testId="resolved-section-toggle"
                className="mt-1"
                threads={resolved}
              />
            )}
          </div>
        </CommentTreeProvider>
      ) : latest ? (
        // Peek preview: a one-line teaser of the latest comment, so the resting
        // sheet shows the live discussion. Tapping it expands to the full list.
        <button
          type="button"
          data-testid="comments-peek-preview"
          onClick={() => setSize("full")}
          className="flex min-w-0 items-center gap-1.5 px-3 pt-0.5 pb-[max(12px,env(safe-area-inset-bottom))] text-left"
        >
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{latest.author}</span>{" "}
            {teaser(latest.body_md)}
          </span>
        </button>
      ) : null}
    </aside>
  )
}

export function OpenPanel(props: {
  openCount: number
  frameRef: RefObject<HTMLIFrameElement | null>
  subscribeGeom: (cb: (g: FrameGeom) => void) => () => void
  onScrollDoc: (dy: number) => void
  pinned: PinItem[]
  general: Comment[][]
  resolved: Comment[][]
  composer: ComposerState
  onHide: () => void
  onNewGeneral: () => void
  onSubmitNew: (text: string, mentions?: Mention[]) => void
  onCancelNew: () => void
  reviewCard?: ReactNode
}) {
  const {
    openCount,
    frameRef,
    subscribeGeom,
    onScrollDoc,
    pinned,
    general,
    resolved,
    composer,
    onHide,
    onNewGeneral,
    onSubmitNew,
    onCancelNew,
    reviewCard,
  } = props
  const { canComment } = useCommentScope()
  const { activeThread, onJump } = useCommentTree()
  const generalComposer = composer && !composer.anchor
  const empty = openCount === 0 && resolved.length === 0 && !composer

  // Prev/Next walks the SAME top-to-bottom order the sidebar itself renders:
  // pinned threads (sorted by their doc-absolute position) then the general
  // drawer, in the order it lists them. Resolved threads are settled, so
  // Prev/Next skips them — it's a tool for working through what's still open.
  const threadOrder = [...pinned]
    .sort((a, b) => a.desiredY - b.desiredY)
    .map((p) => p.thread[0]?.thread_id)
    .concat(general.map((t) => t[0]?.thread_id))
    .filter((id): id is string => !!id)
  const activeIndex = activeThread ? threadOrder.indexOf(activeThread) : -1
  const canGoPrev = activeIndex > 0
  const canGoNext = threadOrder.length > 0 && activeIndex < threadOrder.length - 1
  const goPrev = () => {
    const id = threadOrder[Math.max(0, activeIndex - 1)]
    if (id) onJump(id)
  }
  const goNext = () => {
    const id = threadOrder[activeIndex < 0 ? 0 : Math.min(threadOrder.length - 1, activeIndex + 1)]
    if (id) onJump(id)
  }

  return (
    <>
      <div className="flex items-center gap-1 border-b border-border-soft py-1.5 pl-2.5 pr-2">
        <CommentsHeading count={openCount} />
        {threadOrder.length > 1 && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Previous comment"
                  data-testid="comment-nav-prev"
                  disabled={!canGoPrev}
                  onClick={goPrev}
                >
                  <Icon name="chevron-left" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Previous comment</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Next comment"
                  data-testid="comment-nav-next"
                  disabled={!canGoNext}
                  onClick={goNext}
                >
                  <Icon name="chevron-right" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Next comment</TooltipContent>
            </Tooltip>
          </>
        )}
        {canComment && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="New comment"
                data-testid="comment-new"
                onClick={onNewGeneral}
              >
                <Icon name="plus" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New comment</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Close comments"
              data-testid="comments-panel-close"
              onClick={onHide}
            >
              <Icon name="close" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Close comments <Kbd>c</Kbd>
          </TooltipContent>
        </Tooltip>
      </div>

      {/* The review card lives at the top of the comments rail — one column, not a
          second pane crowding the document. */}
      {reviewCard}

      {/* overflow-clip (not hidden): scrollIntoView / focus-scrolling must not be
          able to shift this box — the pin layer's transform assumes it never moves. */}
      <div className="relative min-h-0 flex-1 overflow-clip">
        {/* Pinned margin — cards (and a new-comment composer) float beside their
            highlighted text, sharing one overlap-free layout. The zone measures its
            own datum against the iframe, so nothing above it (header, review card)
            needs measuring here. */}
        <PinnedZone
          pins={pinned}
          frameRef={frameRef}
          subscribeGeom={subscribeGeom}
          onScrollDoc={onScrollDoc}
          composer={composer}
          onSubmitNew={onSubmitNew}
          onCancelNew={onCancelNew}
        />

        {/* Empty state. */}
        {empty && (
          <div className="absolute inset-0 grid place-items-center p-6">
            <EmptyState
              className="p-0"
              icon={<Icon name="comments" strokeWidth={1.75} />}
              title="Start the conversation."
              description="Select text in the document, or add a general comment."
              action={
                canComment ? (
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="comments-empty-new"
                    onClick={onNewGeneral}
                  >
                    New comment
                  </Button>
                ) : undefined
              }
            />
          </div>
        )}
      </div>

      {/* General + resolved threads live in a scrollable footer drawer. */}
      {(generalComposer || general.length > 0 || resolved.length > 0) && (
        <div className="max-h-[44%] shrink-0 overflow-auto border-t border-border-soft p-2.5">
          {generalComposer && (
            <div className="mb-2.5">
              <Composer quote={null} onSubmit={onSubmitNew} onCancel={onCancelNew} />
            </div>
          )}
          {general.length > 0 && (
            <CollapsibleThreadSection
              label="General"
              defaultOpen
              testId="general-section-toggle"
              threads={general}
            />
          )}
          {resolved.length > 0 && (
            <CollapsibleThreadSection
              label="Resolved"
              defaultOpen={false}
              testId="resolved-section-toggle"
              className="mt-1"
              threads={resolved}
            />
          )}
        </div>
      )}
    </>
  )
}
