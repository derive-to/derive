import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { parseProgress } from "@/api"
import { Spinner } from "@/components/shared/spinner"
import { SidebarMenuButton, SidebarMenuItem, useIconRail } from "@/components/ui/sidebar"
import { activeSyncsQuery } from "@/lib/queries"
import { useDeferredGate } from "@/lib/use-deferred-gate"
import { cn } from "@/lib/utils"

/**
 * Global sync indicator in the app shell, so a running GitHub sync is visible from
 * ANY page — not just Settings. Polls the cheap `/active` endpoint (fast while a sync
 * runs, relaxed when idle), renders the repo + a live mini bar, and deep-links to the
 * GitHub settings tab (the full, giant bar). Renders nothing when nothing is syncing.
 * This is the "no matter where I navigate, I can see it" piece. Renders as a
 * SidebarMenuItem so it sits in the rail's utility menu; the collapsed icon rail
 * shows just the spinner (detail in the tooltip).
 */
export function SyncChip() {
  const iconMode = useIconRail()
  // Ambient status chip (renders null with no active sync) — and it POLLS, so its
  // first fetch is the least urgent request on the page. Waits for the boot to settle.
  const deferred = useDeferredGate()
  const { data } = useQuery({ ...activeSyncsQuery(), enabled: deferred })

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

  // Collapsed icon rail: just the spinner, with the detail in the tooltip. The
  // spinner keeps the brand ink — sync is a sanctioned ink moment.
  if (iconMode)
    return (
      <SidebarMenuItem>
        <SidebarMenuButton asChild tooltip={`${label} · ${detail}`}>
          <Link
            to="/settings/$section"
            params={{ section: "github" }}
            aria-label={`${label} · ${detail}`}
            data-testid="sync-chip"
            className="text-primary [&_svg]:text-primary"
          >
            <Spinner className="size-4 shrink-0 border-[1.5px]" />
            <span>{label}</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    )

  // The ink-tinted chip is a sanctioned brand moment (sync = "this matters");
  // hover deepens the wash instantly — transitions are reserved for movement.
  return (
    <SidebarMenuItem className="pb-1">
      <Link
        to="/settings/$section"
        params={{ section: "github" }}
        data-testid="sync-chip"
        className="flex flex-col gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-2 outline-none hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Spinner className="size-4 shrink-0 border-[1.5px]" />
          <span className="truncate">{label}</span>
          <span className="ml-auto shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
            {detail}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="Sync progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={indeterminate ? undefined : pct}
          className="h-1.5 w-full overflow-hidden rounded-full bg-secondary"
        >
          <div
            className={cn(
              "h-full rounded-full bg-primary transition-[width] duration-500",
              indeterminate && "w-1/3 animate-pulse",
            )}
            style={indeterminate ? undefined : { width: `${pct}%` }}
          />
        </div>
      </Link>
    </SidebarMenuItem>
  )
}
