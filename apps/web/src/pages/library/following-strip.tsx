import type { Follow } from "@/api"
import { Icon } from "@/components/icons"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { Badge } from "@/components/ui/badge"

// The top-of-feed "following" summary + manage surface: the caller's current
// follows as chips — @<login> for GitHub authors, @<handle> for people, <path> for
// paths — each with an unfollow (×). Doubles as the manage-follows surface, so the
// feed and the settings live in one place.
export function FollowingStrip({
  follows,
  onUnfollow,
}: {
  follows: Follow[]
  onUnfollow: (kind: Follow["kind"], target: string) => void
}) {
  if (follows.length === 0) return null
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5" data-testid="following-strip">
      <Eyebrow>Following</Eyebrow>
      {follows.map((fol) => {
        // People-follows store a user id in `target` but carry a resolved `handle`; label
        // them @handle and unfollow BY handle (the server resolves it back to the id).
        const label =
          fol.kind === "author"
            ? `@${fol.target}`
            : fol.kind === "user"
              ? `@${fol.handle ?? fol.target}`
              : fol.target
        const unfollowTarget = fol.kind === "user" ? (fol.handle ?? fol.target) : fol.target
        return (
          // Follow chips are the neutral Badge (never brand tints) in the machine
          // register; overflow-visible lets the unfollow ×'s touch target escape.
          <Badge key={`${fol.kind}:${fol.target}`} className="overflow-visible font-mono text-2xs">
            {label}
            <button
              type="button"
              data-icon="inline-end"
              data-testid={`following-unfollow-${fol.kind}-${unfollowTarget}`}
              aria-label={`Unfollow ${label}`}
              onClick={() => onUnfollow(fol.kind, unfollowTarget)}
              className="relative grid size-4 place-items-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <Icon name="close" size={12} />
              <span
                aria-hidden
                className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
              />
            </button>
          </Badge>
        )
      })}
    </div>
  )
}
