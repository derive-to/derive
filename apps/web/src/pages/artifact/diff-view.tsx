import type { Diff } from "@/api"
import { Spinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

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
        <StatusPanel
          tone="danger"
          title="Couldn't load the changes."
          action={
            onRetry && (
              <Button variant="outline" size="sm" data-testid="diff-retry" onClick={onRetry}>
                Try again
              </Button>
            )
          }
        />
      </div>
    )
  if (!diff)
    return (
      <div className="grid flex-1 place-items-center">
        <Spinner />
      </div>
    )
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
