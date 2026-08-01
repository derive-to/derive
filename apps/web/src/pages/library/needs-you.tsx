import type { Artifact } from "@/api"
import { cn } from "@/lib/utils"

type Signals = Pick<
  Artifact,
  "open_proposals" | "open_threads" | "my_role" | "mentions_me" | "i_participated"
>

/** Everything on a card that means "this wants you", as ONE number.
 *
 *  A card used to carry an open-proposal count and an open-thread count side by side.
 *  Two numbers answering one question: while scanning a grid you are deciding whether to
 *  open something, not triaging what kind of attention it needs — the document itself
 *  tells you that, and it has room to. */
export const needsYouCount = (a: Signals): number => (a.open_proposals ?? 0) + (a.open_threads ?? 0)

/** Whether it needs you PERSONALLY: a review you can act on, or a thread you are tagged
 *  in or already part of. Drives the ink; everything else stays muted. */
export const needsYouIsMine = (a: Signals): boolean =>
  !!a.mentions_me ||
  !!a.i_participated ||
  ((a.open_proposals ?? 0) > 0 && (a.my_role === "owner" || a.my_role === "editor"))

export function NeedsYou({ artifact: a, className }: { artifact: Signals; className?: string }) {
  const n = needsYouCount(a)
  if (n === 0) return null
  const mine = needsYouIsMine(a)
  const parts = [
    (a.open_proposals ?? 0) > 0 &&
      `${a.open_proposals} open ${a.open_proposals === 1 ? "proposal" : "proposals"}`,
    (a.open_threads ?? 0) > 0 &&
      `${a.open_threads} open ${a.open_threads === 1 ? "thread" : "threads"}`,
  ].filter(Boolean)
  return (
    <span
      data-testid="needs-you"
      data-mine={mine ? "true" : undefined}
      // The breakdown lives in the tooltip: available when you want it, absent from the
      // scan. The card is not the place to triage.
      title={parts.join(" · ")}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-1.5 tabular-nums",
        mine ? "border-primary/35 text-primary" : "border-border-soft text-muted-foreground",
        className,
      )}
    >
      {n} {mine ? "needs you" : "open"}
    </span>
  )
}
