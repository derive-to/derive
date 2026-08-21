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
 * answers). The loop is a live dialogue: "looks good, go" is something you SAY —
 * in the note here or in the terminal — never a second decision to make each
 * round. Answering questions is just replying to the anchored threads below.
 * Once settled it shows the last outcome quietly, so the card never nags.
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
  const [note, setNote] = useState("")

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
  // The NOTE rides along — it is where "keep going" and "good to go" both live, so the
  // agent's catch_up can read the answer instead of inferring it.
  const send = useApiMutation({
    mutationFn: () => api.sendBackReview(shortId, note.trim() || undefined),
    onSuccess: () => {
      setNote("")
      void refresh()
    },
  })

  const pending = state.pending
  // Nothing requested, ever → render nothing (the card is review-only chrome).
  if (!pending && !state.last) return null

  if (!pending) {
    // A settled round: a quiet one-line trail, no buttons.
    return (
      <div className="flex items-center gap-2 border-b border-border-soft px-3 py-2 text-xs text-muted-foreground">
        <Icon name="check" size={14} />
        Sent back to the agent.
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
        Reply to the comments, then send the work back. The note below is your answer — "good to go"
        ships it. You do not need to resolve each thread.
      </p>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={send.isPending}
        rows={2}
        placeholder='Answers, asks, or "good to go — ship it"'
        className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        data-testid="review-send-note"
      />
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
