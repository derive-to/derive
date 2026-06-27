import type { Artifact } from "@/api"
import { Icon } from "@/components/icons"
import { cn } from "@/lib/utils"

type Signals = Pick<Artifact, "open_threads" | "mentions_me" | "i_participated">

/** True when an item needs YOUR feedback: you're tagged in, or you authored, an open
 *  thread. Drives both the loud badge and the promoted "Needs your feedback" section. */
export const needsMyFeedback = (a: Signals): boolean => !!(a.mentions_me || a.i_participated)

/** Inline comment indicator for a list item. Plain comment activity reads quietly
 *  (a muted count, like views); an item that needs your feedback gets a loud accent
 *  chip — "Tagged you" (you were @mentioned) outranks "You're in this" (you commented).
 *  Renders nothing when there's no comment activity at all. */
export function CommentSignal({
  artifact: a,
  size = 13,
  className,
}: {
  artifact: Signals
  size?: number
  className?: string
}) {
  const open = a.open_threads ?? 0
  if (open === 0 && !a.mentions_me && !a.i_participated) return null

  const tagged = !!a.mentions_me
  const featured = tagged || !!a.i_participated
  const label = tagged ? "Tagged you" : a.i_participated ? "You're in this" : null
  const title = tagged
    ? "You're tagged in an open thread"
    : a.i_participated
      ? "You commented in an open thread"
      : `${open} open comment thread${open === 1 ? "" : "s"}`

  return (
    <span
      data-testid="comment-signal"
      data-featured={featured ? (tagged ? "tagged" : "participating") : undefined}
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-md font-medium",
        featured && "px-1.5 py-px",
        tagged
          ? "bg-primary/15 text-primary ring-1 ring-inset ring-primary/35"
          : a.i_participated
            ? "text-primary"
            : "text-muted-foreground",
        className,
      )}
    >
      <Icon name="comments" size={size} />
      {open > 0 && <span>{open}</span>}
      {label && <span>{label}</span>}
    </span>
  )
}
