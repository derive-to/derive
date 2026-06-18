import { X } from "lucide-react"
import type { Follow } from "@/api"

// The top-of-feed "following" summary + manage surface: the caller's current
// follows as chips — @<login> for authors, <path> for paths — each with an
// unfollow (×). Doubles as the manage-follows surface, so the feed and the
// settings live in one place.
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
      <span className="mr-0.5 font-mono text-2xs uppercase tracking-[0.07em] text-muted-foreground">
        Following
      </span>
      {follows.map((fol) => {
        const label = fol.kind === "author" ? `@${fol.target}` : fol.target
        return (
          <span
            key={`${fol.kind}:${fol.target}`}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-card py-0.5 pl-2 pr-1 font-mono text-2xs text-foreground"
          >
            {label}
            <button
              type="button"
              data-testid={`following-unfollow-${fol.kind}-${fol.target}`}
              title={`Unfollow ${label}`}
              aria-label={`Unfollow ${label}`}
              onClick={() => onUnfollow(fol.kind, fol.target)}
              className="grid size-4 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        )
      })}
    </div>
  )
}
