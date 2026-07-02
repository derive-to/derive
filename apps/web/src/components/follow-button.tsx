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
  const { isFollowingUser, toggleUser, isTogglingUser } = useFollows()
  // "peek" = pointer hover OR keyboard focus, so the destructive "Unfollow" intent is
  // revealed for touch/keyboard users too — not hover-only (the old a11y bug: a focused
  // or tapped "Following" button gave no hint that activating it unfollows).
  const [peek, setPeek] = useState(false)

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
  // Reveal-on-interaction handlers shared by pointer + keyboard.
  const reveal = {
    onMouseEnter: () => setPeek(true),
    onMouseLeave: () => setPeek(false),
    onFocus: () => setPeek(true),
    onBlur: () => setPeek(false),
  }

  if (following) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={isTogglingUser(username)}
        data-testid={`follow-${username}`}
        aria-pressed
        // Always announce the action (unfollow), independent of the visual peek state,
        // so a screen-reader/keyboard user knows activating this unfollows.
        aria-label={`Unfollow @${username}`}
        {...reveal}
        onClick={onClick}
        className={cn(sizing, peek && "border-destructive/40 text-destructive", className)}
      >
        <Icon name={peek ? "close" : "check"} size={xs ? 12 : 14} />
        {peek ? "Unfollow" : "Following"}
      </Button>
    )
  }
  return (
    // Secondary, never the amber fill: Follow is a row/header action wherever it
    // appears — the page's one primary action lives elsewhere.
    <Button
      variant="secondary"
      size="sm"
      disabled={isTogglingUser(username)}
      data-testid={`follow-${username}`}
      aria-pressed={false}
      aria-label={`Follow @${username}`}
      onClick={onClick}
      className={cn(sizing, className)}
    >
      <Icon name="plus" size={xs ? 12 : 14} />
      Follow
    </Button>
  )
}
