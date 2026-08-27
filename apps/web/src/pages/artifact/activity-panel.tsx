import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { Mention, ReviewRound } from "@/api"
import { Icon } from "@/components/icons"
import { Count } from "@/components/shared/section-eyebrow"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Kbd } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DockedComposer } from "./activity-composer"
import { ActivityStream } from "./activity-stream"
import { FloatingControl } from "./floating-control"
import type { Lens, StreamItem } from "./lib/activity"
import { useCommentScope } from "./lib/comment-scope"
import { useCommentTree } from "./lib/comment-tree"
import { type ComposerState, type FrameGeom, selLabel } from "./types"

const LENS_LABEL: Record<Lens, string> = { all: "All", comments: "Comments" }

/**
 * THE RAIL's desktop body: the activity stream with the composer docked at the bottom.
 * Three levels and nothing else — the stream (content), the composer (action), and the
 * head (context: the count, thread stepping, one lens menu, close). The pending review is
 * a turn in the stream and a chip on the composer, never a card pinned above everything.
 * The page owns the data and the mutations; ArtifactComments builds the items.
 */
export function ActivityPanel(p: {
  /** The rail's tab strip, when the rail has more than one tab — it takes the heading's
   *  place so the row reads "Activity · Chat", never a strip over a repeated title. */
  tabs?: ReactNode
  items: StreamItem[]
  openCount: number
  currentVersion: number
  pendingRound: ReviewRound | null
  lens: Lens
  onLens: (lens: Lens) => void
  composer: ComposerState
  onNewGeneral: () => void
  onSubmitNew: (text: string, mentions?: Mention[]) => void
  onCancelNew: () => void
  onHide: () => void
  visualPinAvailable?: boolean
  visualPinActive?: boolean
  onToggleVisualPin?: () => void
  /** The suggestion / locked one-liners, above the stream. */
  hints?: ReactNode
  editing?: boolean
  onGoToVersion: (n: number) => void
  onSendBack: (note?: string) => void
  sendingBack: boolean
  /** Doc-absolute tops of the open anchored threads, from the frame — "follow the
   *  document" marks the one in the viewport. */
  anchorTops: Record<string, number>
  subscribeGeom: (cb: (g: FrameGeom) => void) => () => void
}) {
  const { canComment } = useCommentScope()
  const { activeThread, onJump } = useCommentTree()
  const [follow, setFollow] = useState(true)
  // A pending round arms the composer on its own (the loop asks one thing); the chip's ✕
  // stands it down for that round, and Answer re-arms it.
  const [dismissedRound, setDismissedRound] = useState<string | null>(null)
  const answering = p.pendingRound && dismissedRound !== p.pendingRound.id ? p.pendingRound : null
  const [focusKey, setFocusKey] = useState(0)
  const focusComposer = () => setFocusKey((k) => k + 1)

  // Prev/Next walks the open threads in the order the stream shows them.
  const threadOrder = p.items.flatMap((it) =>
    it.type === "thread" && it.thread[0]?.state !== "resolved" ? [it.id] : [],
  )
  const activeIndex = activeThread ? threadOrder.indexOf(activeThread) : -1
  const step = (dir: -1 | 1) => {
    const id = threadOrder[activeIndex < 0 ? 0 : activeIndex + dir]
    if (id) onJump(id)
  }

  const newComment = () => {
    p.onNewGeneral()
    focusComposer()
  }
  // A selection just became the composer's quote — bring the caret to it.
  const quote = selLabel(p.composer?.anchor)
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus once per new quote.
  useEffect(() => {
    if (quote) focusComposer()
  }, [quote])
  const answer = () => {
    setDismissedRound(null)
    focusComposer()
  }

  // --- scroll: open at "New" (else the bottom); stay pinned to the bottom as live
  // items land, or offer a jump when the reader has scrolled up to read. ----------
  const list = useRef<HTMLDivElement>(null)
  const marker = useRef<HTMLDivElement | null>(null)
  const atBottom = useRef(true)
  const opened = useRef(false)
  const [pendingNew, setPendingNew] = useState(0)
  const count = p.items.filter((it) => it.type === "thread" || it.type === "turn").length
  const lastCount = useRef(count)
  const lastLens = useRef(p.lens)
  useLayoutEffect(() => {
    if (opened.current || count === 0) return
    opened.current = true
    const el = list.current
    if (marker.current) marker.current.scrollIntoView({ block: "start" })
    else if (el) el.scrollTop = el.scrollHeight
  })
  useEffect(() => {
    const delta = count - lastCount.current
    lastCount.current = count
    // A lens switch changes the count too; only an arrival is news.
    const lensChanged = lastLens.current !== p.lens
    lastLens.current = p.lens
    if (lensChanged || delta <= 0 || !opened.current) return
    const el = list.current
    if (atBottom.current && el) el.scrollTop = el.scrollHeight
    else setPendingNew((n) => n + delta)
  }, [count, p.lens])
  const onScroll = () => {
    const el = list.current
    if (!el) return
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (atBottom.current) setPendingNew(0)
  }
  const jumpToLatest = () => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
    atBottom.current = true
    setPendingNew(0)
  }
  // What you just sent lands at the bottom — go there, so it never reads as "1 new".
  const submit = (text: string, mentions?: Mention[]) => {
    p.onSubmitNew(text, mentions)
    jumpToLatest()
  }

  // --- follow the document: the thread whose highlight is in the document's viewport
  // gets the ink rule and is kept in view here. Geometry arrives imperatively per scroll
  // frame; only a CHANGE of nearest thread touches React state. --------------------
  const [inView, setInView] = useState<string | null>(null)
  const { anchorTops, subscribeGeom } = p
  useEffect(() => {
    if (!follow) {
      setInView(null)
      return
    }
    let raf = 0
    const unsub = subscribeGeom((g) => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const target = g.scrollY + g.viewH * 0.4
        let best: string | null = null
        let bestD = Number.POSITIVE_INFINITY
        for (const [id, top] of Object.entries(anchorTops)) {
          if (top < g.scrollY || top > g.scrollY + g.viewH) continue
          const d = Math.abs(top - target)
          if (d < bestD) {
            bestD = d
            best = id
          }
        }
        setInView((cur) => (cur === best ? cur : best))
      })
    })
    return () => {
      cancelAnimationFrame(raf)
      unsub()
    }
  }, [follow, subscribeGeom, anchorTops])
  useEffect(() => {
    if (!inView) return
    list.current
      ?.querySelector(`[data-thread-id="${inView}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "auto" })
  }, [inView])

  return (
    <>
      <div className="flex items-center gap-1 border-b border-border-soft py-1.5 pl-2.5 pr-2">
        {p.tabs ? (
          <div className="flex min-w-0 flex-1 items-center">{p.tabs}</div>
        ) : (
          <div className="flex min-w-0 flex-1 items-baseline gap-1 pl-1.5">
            <span className="text-sm font-medium text-foreground">Activity</span>
            {p.openCount > 0 && <Count>{p.openCount}</Count>}
          </div>
        )}
        {threadOrder.length > 1 && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Previous comment"
                  data-testid="comment-nav-prev"
                  disabled={activeIndex <= 0}
                  onClick={() => step(-1)}
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
                  disabled={activeIndex >= threadOrder.length - 1}
                  onClick={() => step(1)}
                >
                  <Icon name="chevron-right" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Next comment</TooltipContent>
            </Tooltip>
          </>
        )}
        {canComment && p.visualPinAvailable && p.onToggleVisualPin && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={p.visualPinActive ? "secondary" : "ghost"}
                size="icon-xs"
                aria-label={p.visualPinActive ? "Cancel visual pin" : "Pin comment to a visual"}
                aria-pressed={p.visualPinActive}
                data-testid="comment-visual-pin"
                onClick={p.onToggleVisualPin}
              >
                <Icon name="pin" weight={p.visualPinActive ? "fill" : "regular"} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {p.visualPinActive ? "Cancel visual pin" : "Pin comment to a visual"}
            </TooltipContent>
          </Tooltip>
        )}
        {canComment && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="New comment"
                data-testid="comment-new"
                onClick={newComment}
              >
                <Icon name="plus" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New comment</TooltipContent>
          </Tooltip>
        )}
        {/* The lens and the follow preference — one menu, not a second row of controls. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              data-testid="activity-lens"
              aria-label={`Showing ${LENS_LABEL[p.lens].toLowerCase()} activity`}
              className="text-muted-foreground"
            >
              {LENS_LABEL[p.lens]}
              <Icon name="caret" size={12} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Show</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={p.lens} onValueChange={(v) => p.onLens(v as Lens)}>
              <DropdownMenuRadioItem value="all" data-testid="activity-lens-all">
                All activity
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="comments" data-testid="activity-lens-comments">
                Comments only
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={follow}
              onCheckedChange={(on) => setFollow(on === true)}
              data-testid="activity-follow"
            >
              Follow the document
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Close activity"
              data-testid="comments-panel-close"
              onClick={p.onHide}
            >
              <Icon name="close" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Close activity <Kbd>c</Kbd>
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={list}
          onScroll={onScroll}
          data-testid="activity-stream"
          className="flex h-full flex-col overflow-auto px-2.5 pb-3"
        >
          {p.hints}
          <ActivityStream
            items={p.items}
            currentVersion={p.currentVersion}
            answeringRoundId={answering?.id ?? null}
            inView={inView}
            markerRef={(el) => {
              marker.current = el
            }}
            editing={p.editing}
            emptyTestId="comments-empty-new"
            onNewComment={newComment}
            onGoToVersion={p.onGoToVersion}
            onAnswer={answer}
          />
        </div>
        {pendingNew > 0 && (
          <FloatingControl
            size="sm"
            data-testid="activity-jump-latest"
            onClick={jumpToLatest}
            className="absolute bottom-2 left-1/2 z-20 -translate-x-1/2 tabular-nums"
          >
            <Icon name="caret" size={14} />
            {pendingNew} new
          </FloatingControl>
        )}
      </div>

      {canComment && (
        <DockedComposer
          quote={quote}
          onClearQuote={p.onCancelNew}
          answering={
            answering
              ? {
                  by: answering.requested_by_name,
                  version: answering.version,
                }
              : null
          }
          onStopAnswering={() => setDismissedRound(answering?.id ?? null)}
          onSubmit={submit}
          onSendBack={p.onSendBack}
          sendingBack={p.sendingBack}
          focusKey={focusKey}
        />
      )}
    </>
  )
}
