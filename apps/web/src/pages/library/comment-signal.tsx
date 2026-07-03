import type { Artifact } from "@/api"
import { Icon } from "@/components/icons"
import { cn } from "@/lib/utils"

type Signals = Pick<Artifact, "open_threads" | "mentions_me" | "i_participated">

/** True when an item needs YOUR feedback: you're tagged in, or you authored, an open
 *  thread. Drives both the loud badge and the promoted "Needs your feedback" section. */
export const needsMyFeedback = (a: Signals): boolean => !!(a.mentions_me || a.i_participated)

/** Inline comment indicator for a list item. Plain comment activity reads quietly
 *  (a muted count, like views); an item that needs your feedback gets a soft brand
 *  chip — "Tagged you" (you were @mentioned) outranks "You're in this" (you commented).
 *  The ink accent here is the sanctioned attention signal (like unread), kept to a tint.
 *  Renders nothing when there's no comment activity at all.
 *  Intentionally a hand-rolled span, not Badge: this is a polymorphic three-state meta
 *  signal (muted count / participating / tagged) sized to the 12px mono meta row —
 *  Badge's h-5/text-xs chip scale doesn't fit. */
export function CommentSignal({
  artifact: a,
  size = 12,
  className,
  compact = false,
}: {
  artifact: Signals
  size?: number
  className?: string
  /** Card meta register: icon + count only, tinted when it needs YOU — no prose
   *  label (a promoted "Needs your feedback" section header already says that). */
  compact?: boolean
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

  if (compact)
    return (
      <span
        data-testid="comment-signal"
        data-featured={featured ? (tagged ? "tagged" : "participating") : undefined}
        title={title}
        className={cn(
          "inline-flex items-center gap-1 tabular-nums",
          // The ink tint is the whole signal here — "this thread needs you".
          featured ? "text-primary" : "text-muted-foreground",
          className,
        )}
      >
        <Icon name="comments" size={size} />
        {open > 0 && <span className="font-mono">{open}</span>}
      </span>
    )

  return (
    <span
      data-testid="comment-signal"
      data-featured={featured ? (tagged ? "tagged" : "participating") : undefined}
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-md font-medium",
        featured && "px-1.5 py-px",
        // Flat tonal chip (badge grammar — no ring): soft ink wash + ink text.
        tagged
          ? "bg-primary/10 text-primary"
          : a.i_participated
            ? "text-primary"
            : "text-muted-foreground",
        className,
      )}
    >
      <Icon name="comments" size={size} />
      {open > 0 && <span className="font-mono tabular-nums">{open}</span>}
      {label && <span>{label}</span>}
    </span>
  )
}
