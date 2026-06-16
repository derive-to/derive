import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Loader2 } from "lucide-react"
import { api, parseProgress } from "@/api"
import { cn } from "@/lib/utils"

/**
 * Global sync indicator in the app shell, so a running GitHub sync is visible from
 * ANY page — not just Settings. Polls the cheap `/active` endpoint (fast while a sync
 * runs, relaxed when idle), renders the repo + a live mini bar, and deep-links to the
 * GitHub settings tab (the full, giant bar). Renders nothing when nothing is syncing.
 * This is the "no matter where I navigate, I can see it" piece.
 */
export function SyncChip({ collapsed }: { collapsed: boolean }) {
  const { data } = useQuery({
    queryKey: ["sync-active"],
    queryFn: () => api.activeSyncs(),
    // Tight cadence while a sync is in flight (smooth bar); relaxed when idle so the
    // shell isn't polling hard forever — just often enough to notice a new sync start.
    refetchInterval: (q) => (q.state.data?.active.length ? 1500 : 8000),
    refetchOnWindowFocus: true,
  })

  const active = data?.active ?? []
  if (active.length === 0) return null

  const first = active[0]
  if (!first) return null
  const prog = parseProgress(first.progress)
  const total = prog?.total ?? 0
  const done = prog?.done ?? 0
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  const indeterminate = !prog || total === 0
  const label = active.length > 1 ? `Syncing ${active.length} repos` : `Syncing ${first.repo}`
  const detail =
    total > 0 ? `${done}/${total}` : prog?.phase === "listing" ? "listing…" : "starting…"

  // Collapsed rail: just the spinner, with the detail in the tooltip.
  if (collapsed) {
    return (
      <Link
        to="/settings"
        search={{ tab: "github" }}
        title={`${label} · ${detail}`}
        aria-label={`${label} · ${detail}`}
        data-testid="sync-chip"
        className="flex items-center justify-center rounded-[9px] py-2.5 text-primary transition-colors hover:bg-hover"
      >
        <Loader2 className="size-[18px] animate-spin" aria-hidden />
      </Link>
    )
  }

  return (
    <Link
      to="/settings"
      search={{ tab: "github" }}
      data-testid="sync-chip"
      title={`${label} · ${detail}`}
      className="flex flex-col gap-1.5 rounded-[9px] border border-primary/30 bg-primary/5 px-2.5 py-2 transition-colors hover:bg-primary/10"
    >
      <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
        <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
        <span className="truncate">{label}</span>
        <span className="ml-auto shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
          {detail}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={cn(
            "h-full rounded-full bg-primary transition-all duration-500",
            indeterminate && "w-1/3 animate-pulse",
          )}
          style={indeterminate ? undefined : { width: `${pct}%` }}
        />
      </div>
    </Link>
  )
}
