import { API_BASE, type Proposal } from "@/api"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { STATE_META } from "./shared"

// The rendered experience (proposed or current, in a sandboxed iframe) or the
// source diff, plus the decision-note and stale-base banners above it.
export function ReviewBody({
  shortId,
  view,
  active,
  currentVersion,
  isOpen,
  stale,
  onCompareCurrent,
}: {
  shortId: string
  view: "proposed" | "current" | "diff"
  active: Proposal | null
  currentVersion: number
  isOpen: boolean
  stale: boolean
  onCompareCurrent: () => void
}) {
  const src =
    view === "current"
      ? `${API_BASE}/raw/${shortId}/v/${currentVersion}/index.html`
      : active
        ? `${API_BASE}/raw/${shortId}/p/${active.id}/index.html`
        : "about:blank"

  const decisionNote = active && !isOpen && active.decision_note ? active : null
  const meta = active ? STATE_META[active.state] : null

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-card">
      {decisionNote && meta && (
        <div className="border-b border-border-soft p-3">
          <StatusPanel
            tone={meta.tone}
            layout="inline"
            className="p-3"
            title={`${meta.label}${decisionNote.decided_by ? ` by ${decisionNote.decided_by}` : ""}`}
            description={decisionNote.decision_note}
          />
        </div>
      )}
      {stale && active && (
        // A stale base is a warning, not a destructive failure.
        <div className="border-b border-border-soft p-3">
          <StatusPanel
            tone="warning"
            layout="inline"
            className="p-3"
            title="Out of date"
            description={
              <>
                Proposed against v{active.base_version}, but the live version is now v
                {currentVersion}. Approving replaces v{currentVersion} entirely. Compare against{" "}
                <Button
                  type="button"
                  data-testid="review-compare-current"
                  variant="link"
                  className="h-auto p-0 align-baseline"
                  onClick={onCompareCurrent}
                >
                  Current
                </Button>{" "}
                before approving.
              </>
            }
          />
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {view === "diff" ? (
          <pre
            data-testid="review-diff"
            className="absolute inset-0 m-0 overflow-auto py-3 font-mono text-xs"
          >
            {(active?.diff?.ops ?? []).map((o, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional, no stable id
                key={i}
                className={cn(
                  // Success/destructive tints carry add/remove — never raw greens/reds.
                  "whitespace-pre-wrap break-words px-4",
                  o.t === "add" && "bg-success/10",
                  o.t === "del" && "bg-destructive/10",
                )}
              >
                <span
                  className={cn(
                    "select-none",
                    o.t === "add"
                      ? "text-success"
                      : o.t === "del"
                        ? "text-destructive"
                        : "text-muted-foreground",
                  )}
                >
                  {o.t === "add" ? "+ " : o.t === "del" ? "− " : "  "}
                </span>
                {o.line}
              </div>
            ))}
          </pre>
        ) : (
          <iframe
            data-testid="review-frame"
            title="Proposed version preview"
            src={src}
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
            className="size-full border-0 bg-white"
          />
        )}
      </div>
    </div>
  )
}
