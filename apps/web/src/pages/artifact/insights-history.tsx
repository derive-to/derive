import { useEffect, useState } from "react"
import { type Analytics, type Artifact as Art, api } from "@/api"
import { Icon } from "@/components/icons"
import { ColoredAvatar } from "@/components/shared/colored-avatar"
import { Spinner } from "@/components/shared/spinner"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Sheet, SheetBody, SheetContent, SheetHeader } from "@/components/ui/sheet"
import { ago } from "@/lib/time"
import { cn } from "@/lib/utils"

function StatTile({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-lg border border-border-soft bg-secondary px-4 py-3">
      <div className="font-display text-3xl font-bold leading-none">{value.toLocaleString()}</div>
      <div className="mt-1 font-mono text-2xs uppercase tracking-wider text-muted-foreground">
        {label}
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Insights{title ? ` · ${title}` : ""}</DialogTitle>
        </DialogHeader>
        {!data ? (
          <div className="grid h-40 place-items-center">
            <Spinner />
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-end gap-3">
              <StatTile value={data.unique} label={data.unique === 1 ? "viewer" : "viewers"} />
              <StatTile value={data.total} label={data.total === 1 ? "view" : "views"} />
              <StatTile value={today} label="today" />
              {data.daily.length > 0 && (
                <div className="ml-auto min-w-[160px] flex-1">
                  <div className="mb-1 font-mono text-2xs uppercase tracking-wider text-muted-foreground">
                    Last 30 days
                  </div>
                  <div className="flex h-12 items-end gap-px">
                    {data.daily.map((d) => (
                      <div
                        key={d.day}
                        title={`${d.day}: ${d.count}`}
                        className="min-w-px flex-1 rounded-[1.5px] bg-primary opacity-90"
                        style={{ height: `${Math.max(5, (d.count / max) * 100)}%` }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <div className="mb-2 font-mono text-2xs uppercase tracking-wider text-muted-foreground">
                  Per version
                </div>
                <div className="flex flex-col gap-1.5">
                  {[...data.perVersion]
                    .sort((a, b) => b.version - a.version)
                    .map((v) => (
                      <div key={v.version} className="flex items-center gap-2 text-sm">
                        <span className="w-8 shrink-0 font-mono text-2xs text-muted-foreground">
                          v{v.version}
                        </span>
                        <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-secondary">
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${(v.count / vmax) * 100}%` }}
                          />
                        </div>
                        <span className="w-10 shrink-0 text-right font-mono text-2xs text-muted-foreground">
                          {v.count}
                        </span>
                      </div>
                    ))}
                </div>
              </div>

              <div>
                <div className="mb-2 font-mono text-2xs uppercase tracking-wider text-muted-foreground">
                  Viewed by
                </div>
                {namedRecent.length === 0 && data.anonViewers === 0 ? (
                  <div className="text-sm text-muted-foreground">No views yet.</div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {namedRecent.map((r) => (
                      <div key={r.viewer + r.at} className="flex items-center gap-2 text-sm">
                        {r.avatar ? (
                          <img
                            src={r.avatar}
                            alt=""
                            className="size-[18px] shrink-0 rounded-full object-cover"
                          />
                        ) : (
                          <ColoredAvatar name={r.viewer} size={18} />
                        )}
                        <span className="flex-1 truncate font-medium">{r.viewer}</span>
                        <span className="font-mono text-2xs text-muted-foreground">
                          {ago(r.at)}
                        </span>
                      </div>
                    ))}
                    {data.anonViewers > 0 && (
                      <div className="text-sm text-muted-foreground">
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
  let lastDay = ""
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent title="Version history">
        <SheetHeader>
          <Icon name="history" size={18} />
          Version history
        </SheetHeader>
        <SheetBody>
          {sessions.map((s) => {
            const cur = s.n === shown
            const day = dayLabel(s.created_at)
            const header = day !== lastDay ? day : null
            if (header !== null) lastDay = day
            return (
              <div key={s.n}>
                {header && (
                  <div className="px-2 pb-1 pt-3 font-mono text-2xs uppercase tracking-[0.05em] text-muted-foreground">
                    {header}
                  </div>
                )}
                <button
                  type="button"
                  data-testid={`history-version-${s.n}`}
                  onClick={() => {
                    goTo(s.n)
                    onOpenChange(false)
                  }}
                  className={cn(
                    "mb-px block w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-hover",
                    cur && "bg-accent",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    {s.name ? (
                      <Icon name="pin" size={13} />
                    ) : (
                      <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />
                    )}
                    <span
                      className={cn(
                        "truncate text-sm font-semibold",
                        cur ? "text-primary" : "text-foreground",
                      )}
                    >
                      {s.name ?? clock(s.created_at)}
                    </span>
                    {s.n === art.current_version && (
                      <span className="rounded-full bg-success/15 px-1.5 py-px font-mono text-2xs font-bold text-success">
                        current
                      </span>
                    )}
                    {s.count > 1 && (
                      <span className="ml-auto font-mono text-2xs text-muted-foreground">
                        {s.count} edits
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 pl-[18px] font-mono text-2xs text-muted-foreground">
                    {s.author}
                  </div>
                </button>
              </div>
            )
          })}
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}
