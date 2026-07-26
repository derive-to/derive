import { useCallback, useEffect, useState } from "react"
import { api, type ReviewRound } from "@/api"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { useApiMutation } from "@/lib/use-api-mutation"
import { cn } from "@/lib/utils"

/**
 * The sidebar review card — the human side of the /derive loop. When an agent has
 * requested a review, this sits atop the comments sidebar: what version, how it's
 * going, and the ONE gesture the loop asks of you — **Send back** (return your
 * answers). There is deliberately no Approve button: the loop is a live dialogue,
 * and "looks good, go" is just something you SAY — in a reply here or in the
 * terminal — not a second decision to make each round. (The formal approve
 * primitive still exists server-side for CLI/headless flows: `derive approve`.)
 * Answering questions is just replying to the anchored threads below. Once
 * settled it shows the last outcome quietly, so the card never nags.
 */
export function ReviewCard({
  shortId,
  refreshKey = 0,
}: {
  shortId: string
  /** Bumped by the page on review.* SSE events, so an agent's re-request (or an
   *  action taken in another tab) repaints the card live, never behind a reload. */
  refreshKey?: number
}) {
  const [state, setState] = useState<{ pending: ReviewRound | null; last: ReviewRound | null }>({
    pending: null,
    last: null,
  })

  const refresh = useCallback(async () => {
    try {
      const { pending, rounds } = await api.getReview(shortId)
      setState({ pending, last: rounds[0] ?? null })
    } catch {
      // read-gated; a viewer with no review simply sees nothing.
    }
  }, [shortId])

  useEffect(() => {
    void refreshKey // the SSE-driven repaint signal; reading it ties the effect to it
    void refresh()
  }, [refresh, refreshKey])

  // Send-back through the governed primitive: pending drives the button, and a failure
  // surfaces via the global safety net instead of the silent try/finally this once had.
  const send = useApiMutation({
    mutationFn: () => api.sendBackReview(shortId),
    onSuccess: () => refresh(),
  })

  const pending = state.pending
  // Nothing requested, ever → render nothing (the card is review-only chrome).
  if (!pending && !state.last) return null

  if (!pending) {
    // A settled round: a quiet one-line trail, no buttons.
    const s = state.last?.state
    return (
      <div className="flex items-center gap-2 border-b border-border-soft px-3 py-2 text-xs text-muted-foreground">
        <Icon name="check" size={14} />
        {s === "approved"
          ? "You approved this version."
          : "Sent back to the agent — it's revising."}
      </div>
    )
  }

  return (
    <div
      data-testid="review-card"
      className="flex flex-col gap-2 border-b border-border bg-card px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <span
          className={cn("size-2 flex-none rounded-full bg-success")}
          style={{ animation: "pulse 2s ease-in-out infinite" }}
          aria-hidden
        />
        <span className="font-medium text-sm">Review requested</span>
        <span className="ml-auto font-mono text-2xs text-muted-foreground">v{pending.version}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Answer inline, then send it back — say "good to go" in a reply when you're done. You never
        have to resolve threads.
      </p>
      <div className="flex items-center">
        <Button
          size="sm"
          onClick={() => send.mutate()}
          disabled={send.isPending}
          className="ml-auto"
          data-testid="review-send-back"
        >
          {send.isPending ? "Sending…" : "Send back to the agent"}
        </Button>
      </div>
    </div>
  )
}
