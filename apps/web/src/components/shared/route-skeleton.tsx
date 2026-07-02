import { Skeleton } from "@/components/ui/skeleton"

// Router-level pending placeholder. Shown in the content area (the persistent
// rail + top bar stay put) when a route's loader runs longer than
// defaultPendingMs (150ms, held for defaultPendingMinMs 300ms — see router.tsx),
// so a slow nav shows a shaped shimmer instead of a blank flash or a frozen
// previous page. Deliberately content-agnostic — a heading line over a filling
// panel reads fine for both a document and a list. Blocks are plain bg-muted
// (ui/skeleton), no card chrome; reduced motion is handled there too.
export function RouteSkeleton() {
  return (
    // Mirrors PageShell's measure geometry (wide column, 20px → 32px gutters)
    // so the shimmer's heading sits where the incoming page's header lands.
    <div
      className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-3 p-5 sm:p-8"
      aria-hidden
    >
      <Skeleton className="h-7 w-44" />
      <Skeleton className="flex-1 rounded-lg" />
    </div>
  )
}
