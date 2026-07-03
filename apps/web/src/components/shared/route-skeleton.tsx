import { PageShell } from "@/components/shared/page-shell"
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
    // The real PageShell (wide), not a hand-mirrored copy — scroll wrapper,
    // scrollbar gutter, and measure geometry all come from the source, so
    // there are no values to keep in sync. The width is deliberately biased to
    // the wide Library (max-w-5xl) — the heaviest loader and the one most likely
    // to show this shimmer; reading-width routes (People/Settings/Profile,
    // max-w-3xl) may therefore shift horizontally by the column-width delta on
    // very wide viewports when their loader is slow. min-h-full on the measure
    // resolves (PageShell's scroll wrapper is a definite-height flex child),
    // keeping the panel filling toward the viewport bottom. The sr-only STATUS
    // announces; the shimmer blocks themselves are AT-hidden inside
    // ui/skeleton — the Roselli skeleton pattern.
    <PageShell width="wide" className="flex min-h-full flex-col gap-3">
      <span role="status" className="sr-only">
        Loading page…
      </span>
      <Skeleton className="h-7 w-44" />
      <Skeleton className="flex-1 rounded-lg" />
    </PageShell>
  )
}
