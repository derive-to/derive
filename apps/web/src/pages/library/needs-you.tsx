import type { Artifact } from "@/api"
import { cn } from "@/lib/utils"

type Signals = Pick<Artifact, "open_threads" | "my_role" | "mentions_me" | "i_participated">

/** Everything on a card that means "this wants you", as ONE number: the open threads.
 *  While scanning a grid you are deciding whether to open something, not triaging what
 *  kind of attention it needs — the artifact itself tells you that. */
export const needsYouCount = (a: Signals): number => a.open_threads ?? 0

/** Whether it needs YOU, rather than merely being busy: `mentions_me`/`i_participated`
 *  are facts about threads, so they only mean something while a thread is actually
 *  open — an old thread you commented in must not ink a badge on its own. */
const needsYouIsMine = (a: Signals): boolean =>
  (a.open_threads ?? 0) > 0 && (!!a.mentions_me || !!a.i_participated)

export function NeedsYou({ artifact: a, className }: { artifact: Signals; className?: string }) {
  const n = needsYouCount(a)
  if (n === 0) return null
  const mine = needsYouIsMine(a)
  const parts = [
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
      {n} {mine ? (n === 1 ? "needs you" : "need you") : "open"}
    </span>
  )
}
