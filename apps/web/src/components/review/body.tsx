import { API_BASE, type Proposal } from "@/api"
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
    <div className="relative min-w-0 flex-1 bg-card">
      {decisionNote && meta && (
        <div
          className={cn(
            "border-b border-border-soft px-4 py-2.5 text-xs leading-relaxed",
            meta.banner,
          )}
        >
          <b className={meta.text}>
            {meta.label}
            {decisionNote.decided_by ? ` by ${decisionNote.decided_by}` : ""}:
          </b>{" "}
          {decisionNote.decision_note}
        </div>
      )}
      {stale && active && (
        <div className="border-b border-border-soft bg-destructive/10 px-4 py-2.5 text-xs leading-relaxed">
          <b className="text-destructive">Out of date:</b> proposed against v{active.base_version},
          but the live version is now v{currentVersion}. Approving replaces v{currentVersion}{" "}
          entirely — compare against{" "}
          <button
            type="button"
            data-testid="review-compare-current"
            className="font-semibold text-primary underline-offset-2 hover:underline"
            onClick={onCompareCurrent}
          >
            Current
          </button>{" "}
          before approving.
        </div>
      )}

      <div
        className={cn("absolute inset-x-0 bottom-0", decisionNote || stale ? "top-11" : "top-0")}
      >
        {view === "diff" ? (
          <pre
            data-testid="review-diff"
            className="absolute inset-0 m-0 overflow-auto py-3 font-mono text-xs leading-relaxed"
          >
            {(active?.diff?.ops ?? []).map((o, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional, no stable id
                key={i}
                className={cn(
                  "whitespace-pre-wrap break-words px-4",
                  o.t === "add" && "bg-muted",
                  o.t === "del" && "bg-destructive/10",
                )}
              >
                <span className="select-none text-muted-foreground">
                  {o.t === "add" ? "+ " : o.t === "del" ? "− " : "  "}
                </span>
                {o.line}
              </div>
            ))}
          </pre>
        ) : (
          <iframe
            data-testid="review-frame"
            title="review"
            src={src}
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
            className="size-full border-0 bg-white"
          />
        )}
      </div>
    </div>
  )
}
