import { type ReactNode, useState } from "react"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { ResolvedRow, TurnRow } from "./activity-rows"
import { CommentCard } from "./comment-thread"
import type { StreamItem } from "./lib/activity"
import { useCommentScope } from "./lib/comment-scope"
import { useCommentTree } from "./lib/comment-tree"

/**
 * The stream itself — the items `buildStream` produced, rendered: day eyebrows, the one
 * ink "New" line, comment threads as cards (resolved ones folded to a line), every other
 * action as a one-line turn. Shared by the desktop rail and the phone sheet, so the two
 * can't drift; each surface brings its own header, composer and scroll behaviour.
 */
export function ActivityStream({
  items,
  currentVersion,
  answeringRoundId,
  inView,
  markerRef,
  editing,
  emptyTestId,
  onNewComment,
  onGoToVersion,
  onAnswer,
}: {
  items: StreamItem[]
  currentVersion: number
  /** The round the composer is answering right now, if any. */
  answeringRoundId: string | null
  /** The thread whose highlight is in the document's viewport (desktop "follow"). */
  inView?: string | null
  /** The "New" marker's element, for the surface that scrolls to it on open. */
  markerRef?: (el: HTMLDivElement | null) => void
  editing?: boolean
  emptyTestId: string
  onNewComment: () => void
  onGoToVersion: (n: number) => void
  onAnswer: () => void
}) {
  const { canComment } = useCommentScope()
  const { activeThread, onJump } = useCommentTree()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [openResolved, setOpenResolved] = useState<ReadonlySet<string>>(() => new Set())
  const now = Date.now()
  const toggle = (set: ReadonlySet<string>, id: string) => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }

  if (items.every((it) => it.type === "section"))
    return (
      <EmptyState
        className="flex-1 p-6"
        icon={<Icon name="comments" strokeWidth={1.75} />}
        title="Start the conversation."
        description={
          editing
            ? "Selecting text edits it while you're editing. Finish or leave editing to comment on a passage."
            : "Select text in the artifact, or add a general comment."
        }
        action={
          canComment ? (
            <Button variant="outline" size="sm" data-testid={emptyTestId} onClick={onNewComment}>
              New comment
            </Button>
          ) : undefined
        }
      />
    )

  return items.map((it): ReactNode => {
    switch (it.type) {
      case "section":
        return (
          <div key={it.id} className="flex items-center gap-2 pt-3 pb-1">
            <Eyebrow>{it.label}</Eyebrow>
            <Separator className="flex-1" />
          </div>
        )
      case "unread":
        return (
          <div
            key={it.id}
            ref={markerRef}
            data-testid="activity-unread-marker"
            className="flex items-center gap-2 py-2"
          >
            <Separator className="flex-1 bg-primary" />
            <Eyebrow className="text-primary">New</Eyebrow>
            <Separator className="flex-1 bg-primary" />
          </div>
        )
      case "thread":
        if (it.thread[0]?.state === "resolved")
          return (
            <ResolvedRow
              key={it.id}
              thread={it.thread}
              now={now}
              // Activated (a ?comment deep link, a jump) means shown — never a folded row.
              open={openResolved.has(it.id) || activeThread === it.id}
              onToggle={() => setOpenResolved((s) => toggle(s, it.id))}
            />
          )
        return (
          <div
            key={it.id}
            data-thread-id={it.id}
            className={cn(
              "relative py-1",
              // Follow the document: the in-view thread carries the ink rule.
              inView === it.id &&
                "before:absolute before:-left-2.5 before:top-2 before:bottom-2 before:w-0.5 before:rounded-full before:bg-primary",
            )}
          >
            <CommentCard thread={it.thread} />
          </div>
        )
      case "turn":
        return (
          <TurnRow
            key={it.id}
            turn={it}
            now={now}
            expanded={expanded.has(it.id)}
            onToggle={() => setExpanded((s) => toggle(s, it.id))}
            currentVersion={currentVersion}
            answering={
              answeringRoundId !== null && it.rows.some((r) => r.id === `rr-${answeringRoundId}`)
            }
            onGoToVersion={onGoToVersion}
            onJump={onJump}
            onAnswer={onAnswer}
          />
        )
      default:
        return null
    }
  })
}
