// Router-level pending placeholder. Shown in the content area (the persistent
// rail + top bar stay put) when a route's loader runs longer than
// defaultPendingMs, so a slow nav shows a shaped shimmer instead of a blank
// flash or a frozen previous page. Deliberately content-agnostic — a heading
// line over a filling panel reads fine for both a document and a list.
export function RouteSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-3 p-5.5" aria-hidden>
      <div className="h-7 w-44 animate-pulse rounded-md bg-muted" />
      <div className="flex-1 animate-pulse rounded-lg border border-border bg-card" />
    </div>
  )
}
