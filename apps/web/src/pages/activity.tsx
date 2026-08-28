import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import type { Comment, ReviewRound } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { SectionHeading } from "@/components/shared/section-title"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { useAuth } from "@/ctx"
import { workspaceActivityQuery, workspaceQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { ActorGlyph, LINE, TurnRow } from "./artifact/activity-rows"
import { StreamSkeleton } from "./artifact/activity-stream"
import { type ActivityArtifact, buildStream, stamp } from "./artifact/lib/activity"
import { groupThreads } from "./artifact/lib/layout"
import { refFor } from "./artifact/parse-ref"
import { useActivitySeen } from "./artifact/use-activity-seen"

/** An ask is "waiting" once it has sat this long. */
const STALE_MS = 3 * 86_400_000
/** Rows shown per Needs-you group before "Show more". */
const NEEDS_CAP = 5

/**
 * The Activity page's two sections — the workspace's "Needs you" and its "Recent
 * activity" — from one request (lib/queries.ts workspaceActivityQuery). Its own place,
 * beside Notifications: the Artifacts page stays the document grid,
 * the bell stays what was addressed to you, and this is what is happening.
 *
 * Needs you: the review rounds pending FOR this person across the workspace, and the open
 * threads they are tagged in or have commented on — one line each, the action at the
 * line's end. A round can only be settled from its document, so Answer opens it (the rail
 * arms itself to answer).
 *
 * Recent activity: the artifact rail's stream over the whole workspace — actor × document
 * × day folded to one line ("Codex published v5–v6 of Luna dogfood"), newest first, the
 * "New" marker from this person's last visit to the home (per browser), every line
 * opening to its versions or its thread on the document.
 */
export function WorkspaceActivity() {
  const { me } = useAuth()
  const nav = useNavigate()
  const { data: workspace } = useQuery(workspaceQuery())
  const activity = useQuery({ ...workspaceActivityQuery(), enabled: !!me })
  // The last visit is per workspace, keyed like the rail's per artifact; being on the page
  // is "open", so leaving it (or hiding the tab) advances the marker.
  const { lastSeen } = useActivitySeen(`ws.${workspace?.id ?? ""}`, true)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(() => new Set())

  const open = (a: ActivityArtifact, search?: { comment?: string }) =>
    nav({ to: "/artifacts/$ref", params: { ref: refFor(a) }, search: search ?? {} })

  if (!me) return null
  if (activity.isPending)
    return (
      <section>
        <SectionHeading>Recent activity</SectionHeading>
        <StreamSkeleton />
      </section>
    )
  if (activity.isError)
    return (
      <StatusPanel
        tone="danger"
        layout="inline"
        title="Couldn’t load activity."
        action={
          <Button
            variant="outline"
            size="sm"
            data-testid="wa-retry"
            onClick={() => activity.refetch()}
          >
            Try again
          </Button>
        }
      />
    )

  const data = activity.data
  const now = Date.now()
  const artifacts: Record<string, ActivityArtifact> = Object.fromEntries(
    data.artifacts.map((a) => [a.id, { short_id: a.short_id, title: a.title }]),
  )
  const docOf = (id: string) => artifacts[id]

  // ---- Needs you
  const asks = data.rounds
    .flatMap((r) => {
      const artifact = docOf(r.artifact_id)
      return r.state === "pending" && r.requested_for === me.id && artifact
        ? [{ round: r, artifact }]
        : []
    })
    .sort((a, b) => b.round.created_at.localeCompare(a.round.created_at))
  const threads = groupThreads(data.comments).flatMap((t) => {
    const root = t[0]
    const artifact = root && docOf(root.artifact_id)
    if (!root || !artifact || root.state !== "open" || root.deleted) return []
    const tagged = t.some((c) => c.mentions?.some((m) => m.id === me.id))
    const mine = t.some((c) => c.author_id === me.id)
    return tagged || mine ? [{ root, artifact, replies: t.length - 1 }] : []
  })
  threads.sort((a, b) => b.root.created_at.localeCompare(a.root.created_at))
  const needsCount = asks.length + threads.length

  // ---- Recent activity
  const items = buildStream({
    versions: data.versions,
    comments: data.comments,
    rounds: data.rounds,
    workspace: { artifacts, since: data.since },
    order: "desc",
    lastSeen,
    meId: me.id,
    me: me.name ?? undefined,
    lens: "all",
    now,
  })
  const turnCount = items.filter((it) => it.type === "turn").length
  if (!needsCount && !turnCount)
    return (
      <EmptyState
        className="py-16"
        icon={<Icon name="history" strokeWidth={1.75} />}
        title="Quiet so far."
        description="When people and agents publish, comment, or ask for a review, it shows up here."
      />
    )

  const toggle = (set: ReadonlySet<string>, id: string) => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }
  const capped = <T,>(key: string, all: T[]) => (showAll.has(key) ? all : all.slice(0, NEEDS_CAP))
  const more = (key: string, all: unknown[]) =>
    all.length > NEEDS_CAP &&
    !showAll.has(key) && (
      <Button
        variant="ghost"
        size="sm"
        className="ml-5 self-start text-muted-foreground"
        data-testid={`wa-needs-more-${key}`}
        onClick={() => setShowAll((s) => toggle(s, key))}
      >
        Show {all.length - NEEDS_CAP} more
      </Button>
    )

  return (
    <div className="flex flex-col gap-10" data-testid="wa-root">
      {needsCount > 0 && (
        <section className="flex flex-col gap-2" data-testid="wa-needs-you">
          <SectionHeading count={needsCount}>Needs you</SectionHeading>
          {asks.length > 0 && (
            <div className="flex flex-col">
              <Eyebrow as="h3" className="px-1.5 pt-1 pb-1">
                Reviews waiting on you
              </Eyebrow>
              {capped("asks", asks).map(({ round, artifact }) => (
                <AskLine key={round.id} round={round} artifact={artifact} now={now} onOpen={open} />
              ))}
              {more("asks", asks)}
            </div>
          )}
          {threads.length > 0 && (
            <div className="flex flex-col">
              <Eyebrow as="h3" className="px-1.5 pt-1 pb-1">
                Open threads with you
              </Eyebrow>
              {capped("threads", threads).map(({ root, artifact, replies }) => (
                <ThreadLine
                  key={root.thread_id}
                  root={root}
                  replies={replies}
                  artifact={artifact}
                  now={now}
                  onOpen={open}
                />
              ))}
              {more("threads", threads)}
            </div>
          )}
        </section>
      )}
      {turnCount > 0 && (
        <section className="flex flex-col gap-2" data-testid="wa-recent">
          <SectionHeading count={turnCount}>Recent activity</SectionHeading>
          <div className="flex flex-col">
            {items.map((it) => {
              switch (it.type) {
                case "section":
                  return (
                    <Eyebrow key={it.id} as="h3" className="pt-4 pb-1 first:pt-1">
                      {it.label}
                    </Eyebrow>
                  )
                case "unread":
                  return (
                    <div
                      key={it.id}
                      data-testid="wa-unread-marker"
                      className="flex items-center gap-2 py-2"
                    >
                      <Separator className="flex-1 bg-primary" />
                      <Eyebrow className="text-primary">New above</Eyebrow>
                      <Separator className="flex-1 bg-primary" />
                    </div>
                  )
                case "turn": {
                  const doc = it.artifact
                  const go = (search?: { comment?: string }) => doc && open(doc, search)
                  return (
                    <TurnRow
                      key={it.id}
                      turn={it}
                      now={now}
                      expanded={expanded.has(it.id)}
                      onToggle={() => setExpanded((s) => toggle(s, it.id))}
                      currentVersion={0}
                      answering={false}
                      onGoToVersion={() => go()}
                      onJump={(threadId) => go({ comment: threadId })}
                      onAnswer={() => go()}
                    />
                  )
                }
                default:
                  return null
              }
            })}
          </div>
        </section>
      )}
    </div>
  )
}

function AskLine({
  round,
  artifact,
  now,
  onOpen,
}: {
  round: ReviewRound
  artifact: ActivityArtifact
  now: number
  onOpen: (a: ActivityArtifact) => void
}) {
  const stale = now - new Date(round.created_at).getTime() > STALE_MS
  return (
    <div
      className={cn(LINE, "rounded-md px-1.5 py-1 max-sm:items-start sm:items-center")}
      data-testid={`wa-ask-${round.id}`}
    >
      <ActorGlyph
        by={round.requested_by_name ?? "Review"}
        agent={round.requested_by_kind === "agent"}
      />
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 text-sm text-muted-foreground max-sm:line-clamp-2 sm:truncate">
          <span className="font-medium text-foreground">
            {round.requested_by_name ?? "An agent"}
          </span>{" "}
          asked for review of <span className="font-mono text-xs">v{round.version}</span> ·{" "}
          <span className="text-foreground">{artifact.title}</span>
          {round.note && <span className="italic"> — {round.note}</span>}
        </span>
      </div>
      <span className="flex shrink-0 items-center gap-2 max-sm:pt-0.5">
        <span
          className={cn(
            "font-mono text-2xs tabular-nums",
            stale ? "text-warning" : "text-muted-foreground/80",
          )}
          title={new Date(round.created_at).toLocaleString()}
        >
          {stale ? "waiting " : ""}
          {stamp(round.created_at, now)}
        </span>
        <Button
          variant="outline"
          size="xs"
          data-testid="wa-ask-answer"
          onClick={() => onOpen(artifact)}
        >
          Answer
        </Button>
      </span>
    </div>
  )
}

function ThreadLine({
  root,
  replies,
  artifact,
  now,
  onOpen,
}: {
  root: Comment
  replies: number
  artifact: ActivityArtifact
  now: number
  onOpen: (a: ActivityArtifact, search: { comment: string }) => void
}) {
  return (
    <div
      className={cn(LINE, "rounded-md px-1.5 py-1 max-sm:items-start sm:items-center")}
      data-testid={`wa-thread-${root.thread_id}`}
    >
      <ActorGlyph by={root.author} agent={root.author_kind === "agent"} />
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 text-sm text-muted-foreground max-sm:line-clamp-2 sm:truncate">
          <span className="font-medium text-foreground">{root.author}</span> on{" "}
          <span className="text-foreground">{artifact.title}</span>
          <span className="italic"> — {root.body_md}</span>
        </span>
        {replies > 0 && (
          <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
            {replies} {replies === 1 ? "reply" : "replies"}
          </span>
        )}
      </div>
      <span className="flex shrink-0 items-center gap-2 max-sm:pt-0.5">
        <span
          className="font-mono text-2xs tabular-nums text-muted-foreground/80"
          title={new Date(root.created_at).toLocaleString()}
        >
          {stamp(root.created_at, now)}
        </span>
        <Button
          variant="outline"
          size="xs"
          data-testid="wa-thread-reply"
          onClick={() => onOpen(artifact, { comment: root.thread_id })}
        >
          Reply
        </Button>
      </span>
    </div>
  )
}
