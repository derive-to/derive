import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { Comment, Mention } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useFocusTrap } from "@/lib/use-focus-trap"
import { cn } from "@/lib/utils"
import { Composer } from "./comment-composer"
import { CollapsibleThreadSection, CommentCard, PinnedZone } from "./comment-thread"
import { useCommentScope } from "./lib/comment-scope"
import { CommentTreeProvider, useCommentTree } from "./lib/comment-tree"
import { type ComposerState, type PinItem, selLabel } from "./types"

// The comments panel header: a label + the open-thread count (a neutral mono pill,
// not an ink signal). This was a Comments|Personal tab switch until personal comments
// were removed; a single surface needs only a heading.
function CommentsHeading({ count }: { count: number }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-1.5">
      <span className="text-sm font-medium text-foreground">Comments</span>
      {count > 0 && <Badge shape="pill">{count}</Badge>}
    </div>
  )
}

export function MobileComments({
  open,
  openThreads,
  resolved,
  composer,
  onClose,
  onNewGeneral,
  onSubmitNew,
  onCancelNew,
}: {
  open: boolean
  openThreads: Comment[][]
  resolved: Comment[][]
  composer: ComposerState
  onClose: () => void
  onNewGeneral: () => void
  onSubmitNew: (text: string, mentions?: Mention[]) => void
  onCancelNew: () => void
  reviewCard?: ReactNode
}) {
  // Two states only: peek (a slim "Comments (N)" bar — the default) and full (the
  // list). Composing overrides both with a compact composer bar pinned above the
  // keyboard (see the height + `kb` style below), so the box sits flush above the
  // keyboard with the document visible above — no awkward half-height middle state.
  const { canComment } = useCommentScope()
  const tree = useCommentTree()
  const [size, setSize] = useState<"peek" | "full">("peek")
  const sheetRef = useRef<HTMLDivElement>(null)
  useFocusTrap(sheetRef, open)
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
  const empty = openThreads.length === 0 && resolved.length === 0 && !composer
  // The grip toggles peek <-> full.
  const grip = () => setSize((s) => (s === "peek" ? "full" : "peek"))
  // Jumping to text: drop to the peek bar so the highlight is visible in the doc.
  const jumpToText = (id: string) => {
    setSize("peek")
    tree.onJump(id)
  }
  // The sheet's cards read this overridden tree: jumping also collapses the sheet, and
  // touch has no hover (so no emphasis state) — everything else is the page's tree.
  const sheetTree = { ...tree, hoverThread: null, onHover: () => {}, onJump: jumpToText }
  return (
    <>
      {/* Backdrop only at full height (reading mode). At half the document above
          stays tappable/scrollable, so no dimming layer intercepts it. */}
      <button
        type="button"
        data-testid="comments-sheet-backdrop"
        aria-label="Collapse comments"
        tabIndex={open && !composer && size === "full" ? 0 : -1}
        onClick={() => setSize("peek")}
        className={cn(
          "fixed inset-0 z-60 bg-scrim/50 transition-opacity",
          open && !composer && size === "full" ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <div
        ref={sheetRef}
        className={cn(
          "fixed inset-x-0 bottom-0 z-61 flex flex-col rounded-t-2xl border-t border-border bg-card shadow-[var(--shadow-pop)] duration-200",
          // Don't animate height while the keyboard repositions the sheet.
          kb ? "transition-transform" : "transition-[transform,height]",
          // Composing: a compact bar sized to its content (capped), so the box sits
          // flush above the keyboard rather than high up in a tall sheet.
          composer ? "max-h-[80vh]" : size === "full" ? "h-[88vh]" : "h-18.5",
          open ? "translate-y-0" : "translate-y-full",
        )}
        // While the keyboard is up, lift the sheet's bottom to just above it and cap
        // its height to the visible band — so the half-height composer sits in view
        // (with a sliver of document above) instead of behind/under the keyboard.
        style={kb ? { bottom: kb.inset, maxHeight: kb.height } : undefined}
        role="dialog"
        aria-label="Comments"
      >
        {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: grip resizes the sheet; ✕ closes. */}
        <div
          data-testid="comments-sheet-grip"
          className="flex shrink-0 cursor-grab justify-center pb-1 pt-2"
          onClick={grip}
          title="Resize"
        >
          <div className="h-1 w-10 rounded-full bg-border" />
        </div>
        <div className="flex items-center gap-2 border-b border-border-soft pb-3 pl-3 pr-2.5 pt-2">
          <CommentsHeading count={openThreads.length} />
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
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close comments"
            data-testid="comments-sheet-close"
            onClick={onClose}
          >
            <Icon name="close" className="size-4" />
          </Button>
        </div>
        {composer ? (
          // Composing ("half open"): just the composer, so the sheet is a compact bar
          // pinned above the keyboard with the document visible above. The list
          // reappears once you send or cancel.
          <div className="overflow-auto p-3 pb-[max(14px,env(safe-area-inset-bottom))]">
            <Composer
              quote={selLabel(composer.anchor)}
              agent={composer.agent}
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
                  <div key={head.thread_id} className="mb-2.5">
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
        ) : null}
      </div>
    </>
  )
}

export function OpenPanel(props: {
  openCount: number
  scrollY: number
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
    scrollY,
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
  const generalComposer = composer && !composer.anchor
  const empty = openCount === 0 && resolved.length === 0 && !composer

  // The panel now docks under the full-width top bar, so this header sits above
  // the pinned zone. Cards are placed from the document's top, so feed the
  // header's height down as `topInset` to shift them back into alignment with
  // their highlights (see PinnedZone). Measured, so it tracks any header reflow.
  const headerRef = useRef<HTMLDivElement>(null)
  const [headerH, setHeaderH] = useState(0)
  useLayoutEffect(() => {
    const el = headerRef.current
    if (!el) return
    const sync = () => setHeaderH(el.offsetHeight)
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <>
      <div
        ref={headerRef}
        className="flex items-center gap-1 border-b border-border-soft py-1.5 pl-2.5 pr-2"
      >
        <CommentsHeading count={openCount} />
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

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* Pinned margin — cards (and a new-comment composer) float beside their
            highlighted text, sharing one overlap-free layout. */}
        <PinnedZone
          pins={pinned}
          topInset={headerH}
          scrollY={scrollY}
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
