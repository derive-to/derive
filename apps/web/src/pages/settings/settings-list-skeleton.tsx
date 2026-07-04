import { Skeleton } from "@/components/ui/skeleton"

const ROW_KEYS = ["a", "b", "c", "d", "e", "f"]

// Shape-matched placeholder for a settings section's list body (members, webhooks,
// repos, agents, deliveries, …), replacing the old fixed h-20 centered spinner. The
// section shell + header render immediately (static chrome); only the list swaps to
// this while its data loads. Mirrors a settings row's box model — a leading token,
// a two-line label, and an optional trailing control — with no border/background
// (the divider hairlines belong to the real rows), so nothing shifts on arrival.
export function SettingsListSkeleton({
  rows = 4,
  trailing = true,
}: {
  rows?: number
  trailing?: boolean
}) {
  return (
    <div role="status" className="flex flex-col">
      <span className="sr-only">Loading…</span>
      {ROW_KEYS.slice(0, rows).map((k) => (
        <div key={k} className="flex items-center gap-3 py-3">
          <Skeleton className="size-7 shrink-0 rounded-full" />
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-2.5 w-24" />
          </div>
          {trailing && <Skeleton className="ml-auto h-8 w-28 rounded-lg" />}
        </div>
      ))}
    </div>
  )
}
