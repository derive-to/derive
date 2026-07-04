import { useEffect, useState } from "react"
import { type Analytics, type Artifact as Art, api } from "@/api"
import { Icon } from "@/components/icons"
import { AuthorChip } from "@/components/shared/author-chip"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { getInitials } from "@/lib/initials"
import { ago } from "@/lib/time"
import { cn } from "@/lib/utils"

// Stat grid per the surfaces doctrine: siblings separated by hairline dividers,
// not boxed wells — the number/label contrast carries the hierarchy.
function StatTile({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col gap-1 px-4 first:pl-0 last:pr-0">
      {/* Machine register: counts read as data, not display type. */}
      <div className="font-mono text-3xl font-medium tabular-nums">{value.toLocaleString()}</div>
      <Eyebrow as="div">{label}</Eyebrow>
    </div>
  )
}

const INSIGHT_STATS = ["viewers", "views", "today"]
const INSIGHT_ROWS = ["a", "b", "c", "d"]

// First-load placeholder that mirrors the resolved dialog's own layout: the stat row
// (three number-over-label stacks), the 30-day trend chart block, then the two-column
// Per version / Viewed by grid. Same box model (dims, gaps) minus the dividers/tints,
// so the real analytics land without a jump. role="status".
function InsightsSkeleton() {
  return (
    <div className="flex flex-col gap-5" role="status">
      <span className="sr-only">Loading insights…</span>
      <div className="flex flex-wrap items-end gap-6">
        {/* Stat tiles: a big number over a small label. */}
        <div className="flex gap-8">
          {INSIGHT_STATS.map((k) => (
            <div key={k} className="flex flex-col gap-1.5">
              <Skeleton className="h-8 w-14" />
              <Skeleton className="h-3 w-12" />
            </div>
          ))}
        </div>
        {/* 30-day trend chart block. */}
        <div className="ml-auto min-w-40 flex-1">
          <Skeleton className="mb-1 h-3 w-20" />
          <Skeleton className="h-12 w-full rounded-md" />
        </div>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        {/* Per version: a version label, a bar track, a count. */}
        <div>
          <Skeleton className="mb-2 h-3 w-20" />
          <div className="flex flex-col gap-1.5">
            {INSIGHT_ROWS.map((k) => (
              <div key={k} className="flex items-center gap-2">
                <Skeleton className="h-3 w-8 shrink-0" />
                <Skeleton className="h-2.5 flex-1 rounded-full" />
                <Skeleton className="h-3 w-10 shrink-0" />
              </div>
            ))}
          </div>
        </div>
        {/* Viewed by: an avatar, a name, a timestamp. */}
        <div>
          <Skeleton className="mb-2 h-3 w-20" />
          <div className="flex flex-col gap-1.5">
            {INSIGHT_ROWS.map((k) => (
              <div key={k} className="flex items-center gap-2">
                <Skeleton className="size-4.5 shrink-0 rounded-full" />
                <Skeleton className="h-3.5 flex-1" />
                <Skeleton className="h-3 w-10 shrink-0" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// Insights: a roomy analytics dialog (viewers + views + 30-day trend, per-version
// breakdown, and who's viewed it). Controlled by the toolbar's "⋯ More" menu.
export function Insights({
  shortId,
  title,
  open,
  onOpenChange,
}: {
  shortId: string
  title?: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [data, setData] = useState<Analytics | null>(null)
  useEffect(() => {
    if (open && !data)
      api
        .analytics(shortId)
        .then(setData)
        .catch(() => {})
  }, [open, data, shortId])

  const max = data ? Math.max(1, ...data.daily.map((d) => d.count)) : 1
  const vmax = data ? Math.max(1, ...data.perVersion.map((v) => v.count)) : 1
  const namedRecent = data ? data.recent.filter((r) => r.kind === "user") : []
  const today = data?.daily.at(-1)?.count ?? 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The stat row + charts are the content — no prose description (Radix opt-out). */}
      <DialogContent className="sm:max-w-2xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Insights{title ? ` · ${title}` : ""}</DialogTitle>
        </DialogHeader>
        {!data ? (
          <InsightsSkeleton />
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-end gap-6">
              <div className="flex divide-x divide-border">
                <StatTile value={data.unique} label={data.unique === 1 ? "viewer" : "viewers"} />
                <StatTile value={data.total} label={data.total === 1 ? "view" : "views"} />
                <StatTile value={today} label="today" />
              </div>
              {data.daily.length > 0 && (
                <div className="ml-auto min-w-40 flex-1">
                  <Eyebrow as="div" className="mb-1">
                    Last 30 days
                  </Eyebrow>
                  <div className="flex h-12 items-end gap-px">
                    {data.daily.map((d) => (
                      <div
                        key={d.day}
                        title={`${d.day}: ${d.count}`}
                        className="min-w-px flex-1 rounded-xs bg-chart-1 opacity-90"
                        style={{ height: `${Math.max(5, (d.count / max) * 100)}%` }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <Eyebrow as="div" className="mb-2">
                  Per version
                </Eyebrow>
                <div className="flex flex-col gap-1.5">
                  {[...data.perVersion]
                    .sort((a, b) => b.version - a.version)
                    .map((v) => (
                      <div key={v.version} className="flex items-center gap-2 text-sm">
                        <span className="w-8 shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
                          v{v.version}
                        </span>
                        <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-secondary">
                          <div
                            className="h-full rounded-full bg-chart-1"
                            style={{ width: `${(v.count / vmax) * 100}%` }}
                          />
                        </div>
                        <span className="w-10 shrink-0 text-right font-mono text-2xs text-muted-foreground tabular-nums">
                          {v.count}
                        </span>
                      </div>
                    ))}
                </div>
              </div>

              <div>
                <Eyebrow as="div" className="mb-2">
                  Viewed by
                </Eyebrow>
                {namedRecent.length === 0 && data.anonViewers === 0 ? (
                  <div className="text-sm text-muted-foreground">No views yet.</div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {namedRecent.map((r) => (
                      <div key={r.viewer + r.at} className="flex items-center gap-2 text-sm">
                        <Avatar className="size-4.5">
                          {r.avatar && <AvatarImage src={r.avatar} alt="" />}
                          <AvatarFallback className="text-2xs">
                            {getInitials(r.viewer)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="flex-1 truncate font-medium">{r.viewer}</span>
                        <span className="font-mono text-2xs text-muted-foreground">
                          {ago(r.at)}
                        </span>
                      </div>
                    ))}
                    {data.anonViewers > 0 && (
                      <div className="text-sm text-muted-foreground tabular-nums">
                        + {data.anonViewers.toLocaleString()} anonymous
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// Quiet, Docs-style history in a side drawer: time-grouped sessions (named
// checkpoints pinned), not every raw revision. Controlled by "⋯ More".
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
const dayLabel = (iso: string): string => {
  const d = new Date(iso)
  const today = new Date()
  const y = new Date(today)
  y.setDate(today.getDate() - 1)
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (same(d, today)) return "Today"
  if (same(d, y)) return "Yesterday"
  return d.toLocaleDateString([], { month: "short", day: "numeric" })
}

export function HistoryDrawer({
  art,
  shown,
  goTo,
  open,
  onOpenChange,
}: {
  art: Art
  shown: number
  goTo: (n: number) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const sessions =
    art.sessions ??
    [...art.versions]
      .sort((a, b) => b.n - a.n)
      .map((v) => ({
        n: v.n,
        from_n: v.n,
        count: 1,
        author: v.author,
        name: v.name,
        created_at: v.created_at,
      }))
  // A session is the latest version in a time group; its `n` is that version, so
  // we resolve the rich author identity (avatar, login, the Derive handle for the
  // profile link) from the matching version.
  const versionByN = new Map(art.versions.map((v) => [v.n, v]))
  let lastDay = ""
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Icon name="history" size={16} />
            Version history
          </SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {sessions.map((s) => {
            const cur = s.n === shown
            const day = dayLabel(s.created_at)
            const header = day !== lastDay ? day : null
            if (header !== null) lastDay = day
            return (
              <div key={s.n}>
                {header && (
                  <Eyebrow as="div" className="px-2 pb-1 pt-3">
                    {header}
                  </Eyebrow>
                )}
                {/* Stretched-link row: the select button covers the row (::after) while
                    the author chip sits above it (z-20) so its profile link stays
                    independently clickable — no anchor nested in a button. */}
                <div
                  className={cn(
                    "group relative mb-px rounded-md p-2 hover:bg-secondary",
                    // The selected version is a neutral wash — never an ink tint.
                    cur && "bg-accent",
                  )}
                >
                  <button
                    type="button"
                    data-testid={`history-version-${s.n}`}
                    onClick={() => {
                      goTo(s.n)
                      onOpenChange(false)
                    }}
                    className="block w-full text-left outline-none after:absolute after:inset-0 after:z-1 after:rounded-md after:content-[''] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
                  >
                    <div className="flex items-center gap-1.5">
                      {s.name ? (
                        <Icon name="pin" size={16} />
                      ) : (
                        <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />
                      )}
                      <span className="truncate text-sm font-medium text-foreground">
                        {s.name ?? clock(s.created_at)}
                      </span>
                      {s.n === art.current_version && (
                        // The live version gets the sanctioned soft brand chip.
                        <Badge shape="pill" variant="brand">
                          current
                        </Badge>
                      )}
                      {s.count > 1 && (
                        <span className="ml-auto font-mono text-2xs text-muted-foreground tabular-nums">
                          {s.count} edits
                        </span>
                      )}
                    </div>
                  </button>
                  {(() => {
                    const v = versionByN.get(s.n)
                    return (
                      <div className="relative z-20 mt-0.5 flex pl-4.5">
                        <AuthorChip
                          name={s.author || v?.author || null}
                          login={v?.author_login ?? null}
                          avatar={v?.author_avatar ?? null}
                          handle={v?.handle ?? null}
                          size="xs"
                          data-testid={`history-version-author-${s.n}`}
                        />
                      </div>
                    )
                  })()}
                </div>
              </div>
            )
          })}
        </div>
      </SheetContent>
    </Sheet>
  )
}
