import { useCallback, useEffect, useState } from "react"
import { api, type ReviewRound } from "@/api"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * The sidebar review card — the human side of the /derive loop. When an agent has
 * requested a review, this sits atop the comments sidebar: what version, how it's
 * going, and the one gesture that matters — **Send back** (return your answers) —
 * plus **Approve** for editors (the build go-signal). Answering questions is just
 * replying to the anchored threads below; the buttons here settle the round. Once
 * settled it shows the last outcome quietly, so the card never nags.
 */
export function ReviewCard({ shortId, canApprove }: { shortId: string; canApprove: boolean }) {
  const [state, setState] = useState<{ pending: ReviewRound | null; last: ReviewRound | null }>({
    pending: null,
    last: null,
  })
  const [busy, setBusy] = useState<"send" | "approve" | null>(null)

  const refresh = useCallback(async () => {
    try {
      const { pending, rounds } = await api.getReview(shortId)
      setState({ pending, last: rounds[0] ?? null })
    } catch {
      // read-gated; a viewer with no review simply sees nothing.
    }
  }, [shortId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const sendBack = async () => {
    setBusy("send")
    try {
      await api.sendBackReview(shortId)
      await refresh()
    } finally {
      setBusy(null)
    }
  }
  const approve = async () => {
    setBusy("approve")
    try {
      await api.approveReview(shortId)
      await refresh()
    } finally {
      setBusy(null)
    }
  }

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
        Answer the questions inline, then send it back. You never have to resolve threads.
      </p>
      <div className="flex items-center gap-1.5">
        {canApprove && (
          <Button
            size="sm"
            variant="outline"
            onClick={approve}
            disabled={!!busy}
            data-testid="review-approve"
          >
            {busy === "approve" ? "Approving…" : "Approve"}
          </Button>
        )}
        <Button
          size="sm"
          onClick={sendBack}
          disabled={!!busy}
          className="ml-auto"
          data-testid="review-send-back"
        >
          {busy === "send" ? "Sending…" : "Send back to the agent"}
        </Button>
      </div>
    </div>
  )
}
