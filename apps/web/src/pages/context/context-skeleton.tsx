import { PageShell } from "@/components/shared/page-shell"
import { Skeleton } from "@/components/ui/skeleton"

// The context cards as silhouettes — reused by the directory's in-component loading
// branch and, wrapped with the header below, by the route's pendingComponent.
export function ContextRowsSkeleton() {
  return (
    <ul className="flex flex-col gap-2">
      {[0, 1, 2].map((i) => (
        <li key={i} className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3">
          <Skeleton className="size-4 rounded" />
          <Skeleton className="h-4 w-40" />
        </li>
      ))}
    </ul>
  )
}

// Match the directory layout during its initial query.
export function ContextsPending() {
  return (
    <PageShell className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="mt-1 h-4 w-full max-w-xl" />
      </div>
      <ContextRowsSkeleton />
    </PageShell>
  )
}

// Shape-matched pending frame for a context console (/contexts/$id): the header + a
// transcript silhouette, so the cold-load reads as "console, loading" — not the generic
// app boot or a bare centered spinner.
export function ConsolePending() {
  return (
    <PageShell className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <Skeleton className="size-5 rounded" />
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-24" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-20 w-full rounded-xl" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </PageShell>
  )
}
