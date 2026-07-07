import { useInfiniteQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Icon, type IconName } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { CenteredSpinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { colorForName } from "@/lib/avatar-tints"
import { activityFeedQuery } from "@/lib/queries"
import { ago, dayLabel } from "@/lib/time"
import { refFor } from "@/pages/artifact/parse-ref"
import { coalesceActivity, describeActivity } from "./lib"

// The tinted kind glyph — the ONE deliberate spot of color per row, riding the
// calm categorical tints (never a hue on the chrome itself). Publish/view read as
// "info" (insights blue); comment keeps its own tint; resolve/proposal share the
// "positive outcome" green.
const KIND_STYLE: Record<string, { icon: IconName; tint: string }> = {
  publish: { icon: "history", tint: "bg-insights/10 text-insights" },
  comment: { icon: "comments", tint: "bg-comments/10 text-comments" },
  resolve: { icon: "check", tint: "bg-review/10 text-review" },
  share: { icon: "share", tint: "bg-share/10 text-share" },
  proposal: { icon: "review", tint: "bg-review/10 text-review" },
  view: { icon: "views", tint: "bg-insights/10 text-insights" },
}

// The workspace Activity feed: everything recorded (publishes, comments, resolved
// threads, shares, proposal decisions, first reads), day-grouped and coalesced —
// one story per (actor, artifact, kind) run, not one row per raw event.
export function ActivityPage() {
  const { data, isPending, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery(activityFeedQuery())
  const items = data?.pages.flatMap((p) => p.items) ?? []
  const coalesced = coalesceActivity(items)
  const days = new Map<string, typeof coalesced>()
  for (const a of coalesced) {
    const label = dayLabel(a.created_at)
    const arr = days.get(label) ?? []
    arr.push(a)
    days.set(label, arr)
  }

  return (
    <PageShell width="wide">
      <PageHeader
        className="mb-5"
        title="Activity"
        subtitle="Everything that's happened across your workspace."
      />
      {isPending ? (
        <CenteredSpinner />
      ) : isError ? (
        <StatusPanel
          tone="danger"
          title="Couldn't load activity"
          description="This is usually temporary."
          action={
            <Button
              variant="outline"
              size="sm"
              data-testid="activity-retry"
              onClick={() => refetch()}
            >
              Try again
            </Button>
          }
        />
      ) : coalesced.length === 0 ? (
        <EmptyState
          icon={<Icon name="activity" strokeWidth={1.75} />}
          title="Nothing has happened yet."
          description="Publishes, comments, and reviews across your workspace show up here."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {Array.from(days.entries()).map(([label, rows]) => (
            <section key={label}>
              <Eyebrow as="h2" className="mb-2">
                {label}
              </Eyebrow>
              <div className="flex flex-col gap-0 divide-y divide-border-soft rounded-lg border border-border bg-card">
                {rows.map((a) => (
                  <ActivityRow key={a.ids[0]} a={a} />
                ))}
              </div>
            </section>
          ))}
          {hasNextPage && (
            <div className="flex justify-center py-2">
              <Button
                variant="outline"
                size="sm"
                data-testid="activity-load-more"
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </div>
      )}
    </PageShell>
  )
}

function ActivityRow({ a }: { a: ReturnType<typeof coalesceActivity>[number] }) {
  const { action, detail } = describeActivity(a)
  const style = KIND_STYLE[a.kind] ?? {
    icon: "activity" as const,
    tint: "bg-muted text-muted-foreground",
  }
  const initial = a.actor.trim().charAt(0).toUpperCase()
  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5 text-sm">
      <span
        className={`flex size-6 shrink-0 items-center justify-center rounded-md ${style.tint}`}
        aria-hidden
      >
        <Icon name={style.icon} size={13} />
      </span>
      <span
        className="flex size-4 shrink-0 items-center justify-center rounded-full text-2xs font-semibold text-scrim-foreground"
        style={{ backgroundColor: colorForName(a.actor) }}
        aria-hidden
      >
        {initial}
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-foreground">
          <span className="font-medium">{a.actor}</span>
          {a.actor_kind === "agent" && (
            <span className="ml-1 rounded-sm border border-border px-1 font-mono text-2xs text-muted-foreground align-middle">
              AGENT
            </span>
          )}{" "}
          {action}{" "}
          <Link
            to="/artifacts/$ref"
            params={{ ref: refFor({ short_id: a.artifact_short_id, title: a.artifact_title }) }}
            className="font-medium underline decoration-border-soft underline-offset-2 hover:decoration-foreground"
          >
            {a.artifact_title ?? a.artifact_short_id}
          </Link>
        </span>
        {detail && <span className="block truncate text-2xs text-muted-foreground">{detail}</span>}
      </span>
      <time dateTime={a.created_at} className="shrink-0 font-mono text-2xs text-muted-foreground">
        {ago(a.created_at)}
      </time>
    </div>
  )
}
