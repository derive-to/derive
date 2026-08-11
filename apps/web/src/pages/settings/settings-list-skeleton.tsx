import { ListRow } from "@/components/shared/list-row"
import { Skeleton } from "@/components/ui/skeleton"

const ROW_KEYS = ["a", "b", "c", "d", "e", "f"]

// Shape-matched placeholder for a settings section's list body (members, webhooks,
// repos, agents, deliveries, …). Renders the REAL ListRow with skeleton content —
// the placeholder shares the row's box model by construction, so it can never
// drift from what arrives (it once sat at py-3 while the rows were py-3.5). No
// border/background: the divider hairlines belong to the real rows.
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
        <ListRow
          key={k}
          leading={<Skeleton className="size-7 shrink-0 rounded-full" />}
          title={<Skeleton className="h-3.5 w-40" />}
          meta={<Skeleton className="h-2.5 w-24" />}
          actions={trailing ? <Skeleton className="h-8 w-28 rounded-lg" /> : undefined}
        />
      ))}
    </div>
  )
}
