import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import type { Comment, Mention, ReviewRound } from "@/api"
import { Icon } from "@/components/icons"
import { Count } from "@/components/shared/section-eyebrow"
import { Button } from "@/components/ui/button"
import { useKeyboardInset } from "@/lib/use-keyboard-inset"
import { cn } from "@/lib/utils"
import { ActivityStream } from "./activity-stream"
import { type RailTab, RailTabs } from "./artifact-chat"
import { Composer } from "./comment-composer"
import type { StreamItem } from "./lib/activity"
import { useCommentScope } from "./lib/comment-scope"
import { CommentTreeProvider, useCommentTree } from "./lib/comment-tree"
import { type ComposerState, selLabel } from "./types"

// Touch has no hover, so the mobile sheet overrides the tree's onHover with this.
const NO_HOVER = () => {}

// A one-line plain-text teaser of a comment body for the peek preview (CSS truncates
// the length; this just flattens whitespace so a multi-line body reads as one line).
const teaser = (md: string) => md.replace(/\s+/g, " ").trim()

// The sheet's header: the label + the open-thread count in the machine count
// register ("Activity · 3") — quieter than a pill blob beside the title.
function ActivityHeading({ count }: { count: number }) {
  return (
    <div className="flex min-w-0 flex-1 items-baseline gap-1 pl-1.5">
      <span className="text-sm font-medium text-foreground">Activity</span>
      {count > 0 && <Count>{count}</Count>}
    </div>
  )
}

export function MobileComments({
  open,
  openThreads,
  items,
  ready,
  currentVersion,
  pendingRound,
  onGoToVersion,
  onSendBack,
  composer,
  onNewGeneral,
  onSubmitNew,
  onCancelNew,
  onHeightChange,
  rail,
  onRail,
  chatPanel,
  mapPanel,
  inspectPanel,
  mapEnabled,
  chatEnabled,
  inspectEnabled,
  openCount,
  editing = false,
}: {
  open: boolean
  /** The open threads in stream order — the stepper and the peek preview walk these. */
  openThreads: Comment[][]
  /** The activity stream (see ArtifactComments); the sheet renders it in its full state. */
  items: StreamItem[]
  ready: boolean
  currentVersion: number
  pendingRound: ReviewRound | null
  onGoToVersion: (n: number) => void
  onSendBack: (note?: string) => void
  composer: ComposerState
  onNewGeneral: () => void
  onSubmitNew: (text: string, mentions?: Mention[]) => void
  onCancelNew: () => void
  /** Inline edit mode is on: selecting text edits rather than quotes it, so the
   *  empty state must not tell the reader to select text for a comment. */
  editing?: boolean
  /** How much of the viewport bottom the sheet currently occupies, in px (0 when
   *  closed). The page reserves exactly this under the document so no black band
   *  is left below it. */
  onHeightChange?: (px: number) => void
  /** THE RAIL on a phone. The peek bar carries Comments → Chat while reading, then adds
   *  Inspect only during an eligible HTML edit session — never a second competing sheet. */
  rail?: RailTab
  onRail?: (r: RailTab) => void
  chatPanel?: ReactNode
  mapPanel?: ReactNode
  inspectPanel?: ReactNode
  mapEnabled?: boolean
  chatEnabled?: boolean
  inspectEnabled?: boolean
  openCount?: number
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
  // Answering the pending review round: the same composer bar, in its send-back mode. A
  // selection composer opening on top takes over (the quote is the newer intent).
  const [answering, setAnswering] = useState(false)
  useEffect(() => {
    if (composer) setAnswering(false)
  }, [composer])
  const answeringRound = answering && pendingRound ? pendingRound : null
  const composing = !!composer || !!answeringRound
  // The keyboard's footprint, so the sheet can pin itself into the visible area
  // above it (shared with inline editing, which needs the same measurement).
  const kb = useKeyboardInset()
  // When the composer closes (submit/cancel), drop focus so iOS dismisses the
  // keyboard instead of leaving it up over an empty sheet (which would keep the
  // sheet pinned/shrunk via `kb`).
  useEffect(() => {
    if (!composing) (document.activeElement as HTMLElement | null)?.blur?.()
  }, [composing])
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
    if (kb || composing) return
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
        "fixed inset-x-0 bottom-0 z-61 flex flex-col rounded-t-2xl border-t border-border bg-card shadow-[var(--shadow-pop)] transition-[translate] duration-state ease-out",
        // Heights are CONTENT-WEIGHTED: composing is a compact bar above the
        // keyboard; expanded hugs its comments up to half the screen (the doc
        // strip above stays visible and live — no reading mode that owns the
        // whole screen); peek is a slim bar, one line taller with a preview.
        composing ? "max-h-[80vh]" : size === "full" ? "max-h-[50vh]" : latest ? "h-24" : "h-18.5",
        open ? "translate-y-0" : "translate-y-full",
      )}
      // While the keyboard is up, lift the sheet's bottom to just above it and cap
      // its height to the visible band — so the half-height composer sits in view
      // (with a sliver of document above) instead of behind/under the keyboard.
      style={kb ? { bottom: kb.inset, maxHeight: kb.height } : undefined}
      // Non-modal by design: the document above stays visible and interactive in
      // every state, so this is an aside, not a dialog (no focus trap, no scrim).
      aria-label="Activity"
    >
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
          {/* The strip REPLACES the static heading when chat is on: same always-docked bar,
              now the way you choose which conversation the sheet is showing. Without chat it
              is the heading it has always been. */}
          {rail && onRail ? (
            <div className="flex min-w-0 flex-1 items-center">
              <RailTabs
                tab={rail}
                commentCount={openCount ?? openThreads.length}
                mapEnabled={mapEnabled}
                chatEnabled={chatEnabled}
                inspectEnabled={inspectEnabled}
                onTab={onRail}
              />
            </div>
          ) : (
            <ActivityHeading count={openThreads.length} />
          )}
          {size === "full" && !composing && openThreads.length > 1 && (
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
          {rail === "comments" && canComment && (
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
      {rail === "map" && mapEnabled ? (
        mapPanel
      ) : rail === "chat" && chatEnabled ? (
        // CHAT owns the body, and brings its own composer — so the comments composer and
        // its keyboard handling stay untouched rather than being taught a second mode.
        chatPanel
      ) : rail === "inspect" && inspectEnabled ? (
        inspectPanel
      ) : composing ? (
        // Composing ("half open"): just the composer, so the sheet is a compact bar
        // pinned above the keyboard with the document visible above. The list
        // reappears once you send or cancel.
        <div className="overflow-auto p-3 pb-[max(14px,env(safe-area-inset-bottom))]">
          <Composer
            quote={composer ? selLabel(composer.anchor) : null}
            answering={
              answeringRound
                ? {
                    by: answeringRound.requested_by_name,
                    version: answeringRound.version,
                  }
                : null
            }
            // After posting, open the full list so the new comment is visible (the
            // sheet would otherwise drop back to the peek bar and hide it).
            onSubmit={(text, mentions) => {
              setSize("full")
              if (answeringRound) {
                onSendBack(text.trim() || undefined)
                setAnswering(false)
              } else onSubmitNew(text, mentions)
            }}
            onCancel={() => (answeringRound ? setAnswering(false) : onCancelNew())}
          />
        </div>
      ) : size === "full" ? (
        <CommentTreeProvider value={sheetTree}>
          <div
            data-testid="activity-stream"
            className="flex min-h-0 flex-1 flex-col overflow-auto px-3 pb-[max(14px,env(safe-area-inset-bottom))]"
          >
            {ready && (
              <ActivityStream
                items={items}
                currentVersion={currentVersion}
                // Answering shows the composer bar instead of the list, so nothing here is.
                answeringRoundId={null}
                editing={editing}
                emptyTestId="comments-sheet-empty-new"
                onNewComment={() => {
                  setSize("full")
                  onNewGeneral()
                }}
                onGoToVersion={onGoToVersion}
                onAnswer={() => setAnswering(true)}
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
