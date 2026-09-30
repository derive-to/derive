import { PageShell } from "@/components/shared/page-shell"
import { Skeleton } from "@/components/ui/skeleton"

// Silhouettes shaped like the agent screens: a group label over 52px rows.
export function AgentRowsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col">
      <Skeleton className="mb-3 h-3 w-20" />
      {Array.from({ length: rows }, (_, i) => i).map((i) => (
        <div
          key={i}
          className="flex h-13 items-center gap-3.5 border-b border-border last:border-b-0"
        >
          <Skeleton className="size-4.5 rounded-full" />
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-4 w-64 max-sm:hidden" />
          <span className="flex-1" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  )
}

function TitleSkeleton() {
  return <Skeleton className="h-7 w-40" />
}

export function AgentsPending() {
  return (
    <PageShell width="wide" className="flex flex-col gap-9">
      <TitleSkeleton />
      <AgentRowsSkeleton />
    </PageShell>
  )
}

export function AgentPending() {
  return (
    <PageShell width="wide" className="flex flex-col gap-6">
      <TitleSkeleton />
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-4 w-full max-w-xl" />
      <AgentRowsSkeleton rows={5} />
    </PageShell>
  )
}

export function NewAgentPending() {
  return (
    <PageShell className="flex flex-col gap-7">
      <TitleSkeleton />
      <Skeleton className="h-40 w-full rounded-xl" />
    </PageShell>
  )
}
