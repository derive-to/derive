import { useEffect, useState } from "react"
import { type Analytics, type Artifact as Art, api } from "@/api"
import { Icon } from "@/components/icons"
import { ColoredAvatar } from "@/components/shared/colored-avatar"
import { Spinner } from "@/components/shared/spinner"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ago } from "@/lib/time"
import { cn } from "@/lib/utils"

export function Insights({ shortId }: { shortId: string }) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<Analytics | null>(null)
  const [off, setOff] = useState(false)
  useEffect(() => {
    if (open && !data && !off)
      api
        .analytics(shortId)
        .then(setData)
        .catch(() => setOff(true))
  }, [open, data, off, shortId])
  if (off) return null
  const max = data ? Math.max(1, ...data.daily.map((d) => d.count)) : 1
  const namedRecent = data ? data.recent.filter((r) => r.kind === "user") : []
  const newestAnonAt = data?.recent.find((r) => r.kind === "anon")?.at
  const moreNamed = data ? Math.max(0, data.unique - data.anonViewers - namedRecent.length) : 0
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          title="View analytics"
          data-testid="artifact-insights"
        >
          <Icon name="insights" size={16} />
          {data ? data.unique.toLocaleString() : "Insights"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[300px] p-3.5">
        {!data ? (
          <div className="grid h-20 place-items-center">
            <Spinner />
          </div>
        ) : (
          <>
            {/* General bar: people-first (viewers), views second, trend right. */}
            <div className="mb-3 flex items-center gap-4 border-b border-border-soft pb-3">
              <div>
                <div className="font-display text-2xl font-bold leading-none">
                  {data.unique.toLocaleString()}
                </div>
                <div className="font-mono text-2xs text-muted-foreground">
                  {data.unique === 1 ? "viewer" : "viewers"}
                </div>
              </div>
              <div>
                <div className="font-display text-2xl font-bold leading-none">
                  {data.total.toLocaleString()}
                </div>
                <div className="font-mono text-2xs text-muted-foreground">
                  {data.total === 1 ? "view" : "views"}
                </div>
              </div>
              {data.daily.length > 0 && (
                <div title="Last 30 days" className="ml-auto flex h-[26px] w-24 items-end gap-px">
                  {data.daily.map((d) => (
                    <div
                      key={d.day}
                      title={`${d.day}: ${d.count}`}
                      className="min-w-px flex-1 rounded-[1.5px] bg-primary opacity-90"
                      style={{ height: `${Math.max(6, (d.count / max) * 100)}%` }}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="mb-1.5 font-mono text-2xs uppercase tracking-[0.06em] text-muted-foreground">
              Viewed by
            </div>
            {namedRecent.length === 0 && data.anonViewers === 0 ? (
              <div className="text-xs text-muted-foreground">No views yet.</div>
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
                    <span className="font-mono text-2xs text-muted-foreground">{ago(r.at)}</span>
                  </div>
                ))}
                {data.anonViewers > 0 && (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="grid size-[18px] shrink-0 place-items-center rounded-full bg-secondary text-xs text-muted-foreground">
                      ·
                    </span>
                    <span className="flex-1 text-muted-foreground">
                      {data.anonViewers.toLocaleString()} anonymous
                    </span>
                    {newestAnonAt && (
                      <span className="font-mono text-2xs text-muted-foreground">
                        {ago(newestAnonAt)}
                      </span>
                    )}
                  </div>
                )}
                {moreNamed > 0 && (
                  <div className="pl-[26px] text-xs text-muted-foreground">+{moreNamed} more</div>
                )}
              </div>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

// Quiet, Docs-style history: the header shows only "Edited {ago}". The dropdown
// lists time-grouped sessions (named checkpoints pinned with a star), not every
// raw revision — version chrome stays out of the way.
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

export function HistoryMenu({
  art,
  shown,
  goTo,
}: {
  art: Art
  shown: number
  goTo: (n: number) => void
}) {
  const [open, setOpen] = useState(false)
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
  const latest = sessions[0]
  let lastDay = ""
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          title="Version history"
          data-testid="artifact-history"
        >
          <Icon name="history" size={16} />
          {latest ? `Edited ${ago(latest.created_at)}` : "History"}
          <Icon name="caret" size={13} className="opacity-70" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[400px] w-[286px] overflow-auto p-1.5">
        <div className="px-2 pb-1 pt-1.5 font-mono text-2xs uppercase tracking-[0.06em] text-muted-foreground">
          Version history
        </div>
        {sessions.map((s) => {
          const cur = s.n === shown
          const day = dayLabel(s.created_at)
          const header = day !== lastDay ? day : null
          if (header !== null) lastDay = day
          return (
            <div key={s.n}>
              {header && (
                <div className="px-2 pb-1 pt-2 font-mono text-2xs uppercase tracking-[0.05em] text-muted-foreground">
                  {header}
                </div>
              )}
              <button
                type="button"
                data-testid={`history-version-${s.n}`}
                onClick={() => {
                  goTo(s.n)
                  setOpen(false)
                }}
                className={cn(
                  "mb-px block w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover",
                  cur && "bg-accent",
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn("text-xs", s.name ? "text-primary" : "text-muted-foreground")}
                  >
                    {s.name ? "★" : "●"}
                  </span>
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
      </PopoverContent>
    </Popover>
  )
}
