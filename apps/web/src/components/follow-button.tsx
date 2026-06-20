import { useState } from "react"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { useFollows } from "@/lib/use-follows"
import { cn } from "@/lib/utils"

// Follow / Following toggle for a person. State comes from the profile's
// `followed_by_me` (people-follows store a user id, so the follows list can't map a
// username to state); the toggle add/removes by username and invalidates the profile
// so the count + button stay live. Render only for a signed-in viewer on someone
// else's profile — the parent decides that.
export function FollowButton({
  username,
  isFollowing,
  className,
}: {
  username: string
  isFollowing: boolean
  className?: string
}) {
  const { toggleUser, pendingFollow } = useFollows()
  const [hover, setHover] = useState(false)

  // Following: a quiet outline that flips to a destructive "Unfollow" on hover.
  if (isFollowing) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={pendingFollow}
        data-testid="follow-button"
        aria-pressed
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={() => toggleUser(username, true)}
        className={cn(hover && "border-destructive/40 text-destructive", className)}
      >
        <Icon name={hover ? "close" : "check"} size={14} />
        {hover ? "Unfollow" : "Following"}
      </Button>
    )
  }
  return (
    <Button
      size="sm"
      disabled={pendingFollow}
      data-testid="follow-button"
      aria-pressed={false}
      onClick={() => toggleUser(username, false)}
      className={className}
    >
      <Icon name="plus" size={14} />
      Follow
    </Button>
  )
}
