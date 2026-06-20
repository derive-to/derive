import { type MouseEvent, useState } from "react"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/ctx"
import { useFollows } from "@/lib/use-follows"
import { cn } from "@/lib/utils"

// A self-contained Follow / Following toggle for a person, keyed by @handle. Drop it in
// anywhere an author appears — it reads the signed-in viewer + the live follows set, and
// renders NOTHING when it doesn't apply (signed-out, or your own handle). Follow-state
// and the toggle both come from useFollows, so every instance stays in sync. Clicks
// stopPropagation so it works inside a card/link/command-item without triggering it.
export function FollowButton({
  username,
  size = "sm",
  className,
}: {
  username: string
  size?: "sm" | "xs"
  className?: string
}) {
  const { me } = useAuth()
  const { isFollowingUser, toggleUser, pendingFollow } = useFollows()
  const [hover, setHover] = useState(false)

  // Nothing to do for a signed-out viewer or on your own profile.
  if (!me || me.username?.toLowerCase() === username.toLowerCase()) return null

  const following = isFollowingUser(username)
  const xs = size === "xs"
  const sizing = xs ? "h-6 gap-1 px-2 text-2xs" : ""
  const onClick = (e: MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    toggleUser(username)
  }

  if (following) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={pendingFollow}
        data-testid={`follow-${username}`}
        aria-pressed
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={onClick}
        className={cn(sizing, hover && "border-destructive/40 text-destructive", className)}
      >
        <Icon name={hover ? "close" : "check"} size={xs ? 12 : 14} />
        {hover ? "Unfollow" : "Following"}
      </Button>
    )
  }
  return (
    <Button
      size="sm"
      disabled={pendingFollow}
      data-testid={`follow-${username}`}
      aria-pressed={false}
      onClick={onClick}
      className={cn(sizing, className)}
    >
      <Icon name="plus" size={xs ? 12 : 14} />
      Follow
    </Button>
  )
}
