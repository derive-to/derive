import type { Diff } from "@/api"
import { LoadError } from "@/components/shared/load-error"
import { StatusPanel } from "@/components/shared/status-panel"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

// Diff-shaped first-load placeholder: a header-meta row (from→to + stat bars) over a
// column of code-line bars at alternating widths. Neutral bg-muted only — no add/del
// tint, since we don't yet know which lines changed. Mirrors DiffView's box model (the
// px-4 line inset, the py-2.5 gutter) but never its border/background. role="status".
const DIFF_WIDTHS = ["w-full", "w-2/3", "w-5/6", "w-1/2"]
const DIFF_LINES = Array.from({ length: 12 }, (_, i) => ({
  id: `l${i}`,
  w: DIFF_WIDTHS[i % DIFF_WIDTHS.length],
}))

function DiffSkeleton() {
  return (
    <div className="flex-1 overflow-hidden" role="status">
      <span className="sr-only">Loading changes…</span>
      {/* Header meta row: from → to, then the +/− and line-count stats. */}
      <div className="flex items-center gap-3 px-4 py-2">
        <Skeleton className="mr-auto h-3.5 w-40" />
        <Skeleton className="h-3.5 w-8" />
        <Skeleton className="h-3.5 w-14" />
      </div>
      {/* Code lines. */}
      <div className="flex flex-col gap-2 px-4 py-2.5">
        {DIFF_LINES.map(({ id, w }) => (
          <Skeleton key={id} className={cn("h-3", w)} />
        ))}
      </div>
    </div>
  )
}

export function DiffView({
  diff,
  fromLabel,
  toLabel,
  failed,
  onRetry,
}: {
  diff: Diff | null
  fromLabel?: string
  toLabel?: string
  failed?: boolean
  onRetry?: () => void
}) {
  if (failed)
    return (
      <div className="grid flex-1 place-items-center">
        {onRetry ? (
          <LoadError title="Couldn’t load the changes." testId="diff-retry" onRetry={onRetry} />
        ) : (
          <StatusPanel tone="danger" title="Couldn’t load the changes." />
        )}
      </div>
    )
  if (!diff) return <DiffSkeleton />
  const adds = diff.ops.filter((o) => o.t === "add").length
  const dels = diff.ops.filter((o) => o.t === "del").length
  return (
    <div className="flex-1 overflow-auto bg-card">
      <div className="flex items-center gap-3 border-b border-border-soft px-4 py-2 text-sm">
        {fromLabel && toLabel && (
          <span className="mr-auto font-mono text-muted-foreground">
            {fromLabel} → {toLabel}
          </span>
        )}
        <span className="font-mono text-success tabular-nums">+{adds}</span>
        <span className="font-mono text-destructive tabular-nums">−{dels}</span>
        <span className="font-mono text-muted-foreground tabular-nums">
          {diff.ops.length} lines
        </span>
      </div>
      <pre className="py-2.5 font-mono text-sm">
        {diff.ops.map((o, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: diff ops are an immutable, never-reordered list rebuilt wholesale per version; lines repeat, so the index is the stable identity.
            key={i}
            className={cn(
              // Add/remove keep their semantic tones: success/destructive tints,
              // never raw greens/reds.
              "whitespace-pre-wrap break-words px-4",
              o.t === "add"
                ? "bg-success/10 text-foreground"
                : o.t === "del"
                  ? "bg-destructive/10 text-foreground"
                  : "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "mr-2.5 select-none",
                o.t === "add" ? "text-success" : o.t === "del" ? "text-destructive" : "text-border",
              )}
            >
              {o.t === "add" ? "+" : o.t === "del" ? "−" : " "}
            </span>
            {o.line || "​"}
          </div>
        ))}
      </pre>
    </div>
  )
}
