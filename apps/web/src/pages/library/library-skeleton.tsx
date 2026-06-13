// Card-grid placeholder for the library's first load. Mirrors the real grid +
// card shape (thumb block, title line, meta line) so nothing jumps when the
// artifacts arrive.
export function LibrarySkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3" aria-hidden>
      {["a", "b", "c", "d", "e", "f", "g", "h"].map((k) => (
        <div key={k} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3.5">
          <div className="aspect-[4/3] animate-pulse rounded-md bg-muted" />
          <div className="h-5 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  )
}
