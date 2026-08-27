import { RotateCcw } from "lucide-react"
import type { Comment } from "@/api"
import { Icon } from "@/components/icons"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { getInitials } from "@/lib/initials"
import { cn } from "@/lib/utils"
import { CommentCard } from "./comment-thread"
import {
  type ActivityRow,
  hasDetail,
  leadRow,
  phrase,
  type ReviewRequestRow,
  stamp,
  type TurnItem,
} from "./lib/activity"
import { useCommentScope } from "./lib/comment-scope"
import { useCommentTree } from "./lib/comment-tree"
import { quoteChipClass } from "./quote-chip"

// The stream's line grammar: a 20px glyph column (who, or what), the sentence, and a
// mono stamp pinned right so it can never orphan onto its own line when the sentence
// wraps or truncates.
const LINE = "grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-start gap-x-2"

const FOCUS =
  "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"

function Stamp({ iso, now }: { iso: string; now: number }) {
  return (
    <span
      title={new Date(iso).toLocaleString()}
      className="pt-0.5 font-mono text-2xs tabular-nums text-muted-foreground/80"
    >
      {stamp(iso, now)}
    </span>
  )
}

// Who did it: a 20px initials avatar (the comment-row register), the soft ink tint
// with a sparkles glyph for an agent, and the review glyph when a round's requester
// resolves to nobody we can name.
function ActorGlyph({ by, agent }: { by: string | null; agent: boolean }) {
  if (!by)
    return (
      <span className="grid size-5 place-items-center text-muted-foreground">
        <Icon name="review" size={16} />
      </span>
    )
  return (
    <Avatar className="size-5">
      <AvatarFallback className={cn("text-2xs", agent && "bg-primary/10 text-primary")}>
        {agent ? <Icon name="sparkles" size={12} /> : getInitials(by)}
      </AvatarFallback>
    </Avatar>
  )
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })

// A turn's opened detail: each row with what its phrase left out — the version list
// (each a jump to that version), the review note and its Answer, the reply body.
function DetailRow({
  row,
  solo,
  currentVersion,
  onGoToVersion,
  onJump,
}: {
  row: ActivityRow
  /** The turn's only row: its line already says what this is, so only the payload
   *  (the note, the reply) shows — never the same phrase twice. */
  solo: boolean
  currentVersion: number
  onGoToVersion: (n: number) => void
  onJump: (threadId: string) => void
}) {
  const head = "flex items-center gap-1.5 text-sm text-muted-foreground"
  switch (row.kind) {
    case "version":
      return (
        <div className="flex flex-col gap-0.5">
          <ul role="list" className="flex flex-col">
            {row.versions.map((v) => (
              <li key={v.n}>
                <button
                  type="button"
                  data-testid={`activity-version-${v.n}`}
                  onClick={() => onGoToVersion(v.n)}
                  title={`View v${v.n}`}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left text-sm text-foreground hover:bg-secondary",
                    FOCUS,
                  )}
                >
                  <span className="w-7 shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                    v{v.n}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{v.message ?? v.name ?? "Edited"}</span>
                  {v.n === currentVersion && (
                    <Badge shape="pill" variant="brand">
                      current
                    </Badge>
                  )}
                  <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                    {clock(v.created_at)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )
    case "review_request":
      // The pending ask is already in full beneath the turn line (see TurnRow).
      if (row.pending) return null
      return (
        <div className="flex flex-col gap-1.5">
          {!solo && (
            <div className={head}>
              <Icon name="review" className="shrink-0" />
              <span className="min-w-0 truncate">
                Asked for your review of <span className="font-mono text-xs">v{row.version}</span>
              </span>
            </div>
          )}
          {row.note && (
            <p
              className={quoteChipClass({
                className: "whitespace-pre-wrap [word-break:break-word]",
              })}
            >
              {row.note}
            </p>
          )}
        </div>
      )
    case "review_sent_back":
      return (
        <div className="flex flex-col gap-1.5">
          {!solo && (
            <div className={head}>
              <Icon name="check" className="shrink-0 text-success" />
              <span className="min-w-0 truncate">
                Sent <span className="font-mono text-xs">v{row.version}</span> back
              </span>
            </div>
          )}
          {row.note && (
            <p
              className={quoteChipClass({
                className: "whitespace-pre-wrap [word-break:break-word]",
              })}
            >
              {row.note}
            </p>
          )}
        </div>
      )
    case "reply":
      return (
        <button
          type="button"
          data-testid={`activity-reply-${row.id}`}
          onClick={() => onJump(row.threadId)}
          title="Open the thread"
          className={cn(
            "flex w-full flex-col gap-0.5 rounded-md text-left hover:bg-secondary",
            FOCUS,
          )}
        >
          {!solo && (
            <span className={head}>
              <Icon name="comments" className="shrink-0" />
              <span className="truncate">Replied in {row.threadAuthor}'s thread</span>
            </span>
          )}
          <span className="line-clamp-2 text-sm text-foreground [word-break:break-word]">
            {row.body}
          </span>
        </button>
      )
    case "resolved":
      return (
        <button
          type="button"
          data-testid={`activity-resolved-${row.threadId}`}
          onClick={() => onJump(row.threadId)}
          title="Open the thread"
          className={cn("flex w-full items-center rounded-md text-left hover:bg-secondary", FOCUS)}
        >
          <span className={head}>
            <Icon name="check" className="shrink-0 text-success" />
            <span className="truncate">
              Resolved {row.threadAuthor}'s thread
              {row.version != null && (
                <>
                  {" "}
                  in <span className="font-mono text-xs">v{row.version}</span>
                </>
              )}
            </span>
          </span>
        </button>
      )
  }
}

/**
 * One line per turn — consecutive actions by one actor on one day. The sentence leads
 * with what matters most (the pending ask, else the publish), the rest is a `+N` that
 * sits outside the ellipsis, and the chevron opens the rows with their detail. A pending
 * review is the single exception to "one line": its note is shown in full with Answer
 * beneath the line, because it is the one thing the loop asks of the reader — and it is
 * never repeated inside the opened detail.
 */
export function TurnRow({
  turn,
  now,
  expanded,
  onToggle,
  currentVersion,
  answering,
  onGoToVersion,
  onJump,
  onAnswer,
}: {
  turn: TurnItem
  now: number
  expanded: boolean
  onToggle: () => void
  currentVersion: number
  /** The composer is currently answering this turn's pending round. */
  answering: boolean
  onGoToVersion: (n: number) => void
  onJump: (threadId: string) => void
  onAnswer: () => void
}) {
  const lead = leadRow(turn)
  const more = turn.rows.length - 1
  const openable = hasDetail(turn)
  const pending = turn.rows.find(
    (r): r is ReviewRequestRow => r.kind === "review_request" && r.pending,
  )
  const line = turn.by ? (
    <>
      <span className="font-medium text-foreground">{turn.by}</span> {phrase(lead)}
    </>
  ) : lead.kind === "review_request" ? (
    <>
      <span className="font-medium text-foreground">Review</span> requested for{" "}
      <span className="font-mono text-xs">v{lead.version}</span>
    </>
  ) : (
    phrase(lead)
  )
  return (
    <div className={cn(LINE, "py-1")} data-testid={`activity-turn-${turn.id}`}>
      <ActorGlyph by={turn.by} agent={turn.agent} />
      <div className="flex min-w-0 flex-col gap-1">
        {openable ? (
          <button
            type="button"
            data-testid="activity-turn-toggle"
            aria-expanded={expanded}
            onClick={onToggle}
            className={cn(
              "flex min-w-0 items-center gap-1 rounded-sm text-left text-sm text-muted-foreground hover:text-foreground",
              FOCUS,
            )}
          >
            <span className="min-w-0 flex-1 truncate">{line}</span>
            {more > 0 && (
              <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                +{more}
              </span>
            )}
            <Icon
              name="chevron-right"
              size={12}
              className={cn("shrink-0 text-muted-foreground", expanded && "rotate-90")}
            />
          </button>
        ) : (
          <span className="block truncate text-sm text-muted-foreground">{line}</span>
        )}
        {pending && (
          <div className="flex flex-col items-start gap-1.5">
            {pending.note && (
              <p
                className={quoteChipClass({
                  className: "whitespace-pre-wrap [word-break:break-word]",
                })}
              >
                {pending.note}
              </p>
            )}
            <Button
              variant="outline"
              size="xs"
              data-testid="review-answer"
              aria-pressed={answering}
              onClick={onAnswer}
            >
              <Icon name="review" />
              Answer
            </Button>
          </div>
        )}
        {expanded && (
          <div className="flex flex-col gap-2 border-l-2 border-border-soft pl-2.5">
            {turn.rows.map((r) => (
              <DetailRow
                key={r.id}
                row={r}
                solo={turn.rows.length === 1}
                currentVersion={currentVersion}
                onGoToVersion={onGoToVersion}
                onJump={onJump}
              />
            ))}
          </div>
        )}
      </div>
      <Stamp iso={turn.until} now={now} />
    </div>
  )
}

/**
 * A resolved thread, folded to one line — who opened it and its first words — that
 * opens to the full (muted) card. Settled feedback stays in the record without taking
 * a card's worth of the rail.
 */
export function ResolvedRow({
  thread,
  now,
  open,
  onToggle,
}: {
  thread: Comment[]
  now: number
  open: boolean
  onToggle: () => void
}) {
  const { canComment } = useCommentScope()
  const { onResolve } = useCommentTree()
  const root = thread[0]
  if (!root) return null
  const res = root.resolution
  return (
    <div className="flex flex-col gap-1 py-0.5">
      <button
        type="button"
        data-testid={`resolved-thread-${root.thread_id}`}
        aria-expanded={open}
        onClick={onToggle}
        className={cn(
          LINE,
          "w-full rounded-md py-1 text-left text-sm text-muted-foreground hover:text-foreground",
          FOCUS,
        )}
      >
        <span className="grid size-5 place-items-center text-success">
          <Icon name="check" size={16} />
        </span>
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 font-medium text-foreground">{root.author}</span>
          <span className="min-w-0 truncate">
            {root.deleted ? "Comment deleted" : root.body_md}
          </span>
        </span>
        <Stamp iso={root.created_at} now={now} />
      </button>
      {open && (
        <>
          {/* The record line: its settling — who, by which version, when — and the one
              action a settled thread has. State is said here and nowhere in the card
              below (`settled`): the card is just the conversation. */}
          <div
            data-testid="thread-resolution"
            className="flex items-center gap-1.5 pl-7 text-xs text-muted-foreground"
          >
            <Icon name="check" size={12} className="shrink-0 text-success" />
            <span className="min-w-0 truncate">
              Resolved{res?.by ? ` by ${res.by}` : ""}
              {res?.version != null ? ` in v${res.version}` : ""}
            </span>
            {res && (
              <span className="shrink-0 font-mono text-2xs tabular-nums">{stamp(res.at, now)}</span>
            )}
            <span className="flex-1" />
            {canComment && (
              <Button
                variant="ghost"
                size="xs"
                data-testid="comment-reopen"
                className="-my-1 -mr-1 text-muted-foreground hover:text-foreground"
                onClick={() => onResolve(root)}
              >
                <RotateCcw aria-hidden className="size-3.5" />
                Reopen
              </Button>
            )}
          </div>
          <CommentCard thread={thread} settled />
        </>
      )}
    </div>
  )
}
