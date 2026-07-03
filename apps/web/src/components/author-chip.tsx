import { Link } from "@tanstack/react-router"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { colorForName } from "@/lib/avatar-tints"
import { getInitials } from "@/lib/initials"
import { cn } from "@/lib/utils"

// One author, rendered as a tiny avatar + name — the "who last changed this" /
// "who authored this version" chip. Fields come straight off the resolved
// `author` (and the per-version author_* fields): a GitHub identity, plus the
// Derive `handle` when that committer signed into Derive.
//
// Three shapes, picked by the props:
//  - `onClick`  → a button (used to filter the list by this author).
//  - `handle`   → a Link to the author's /users/<handle> profile.
//  - neither    → plain, non-interactive text.
export interface AuthorChipProps {
  name: string | null
  login: string | null
  avatar: string | null
  /** The Derive username, when this GitHub user signed in — drives the profile link. */
  handle: string | null
  /** "sm" (default) sits in a meta line; "xs" is the tightest variant. */
  size?: "xs" | "sm"
  /** Avatar-only when false — the name moves to the accessible label + tooltip.
   *  Used on dense grid cards, where a repeated full name is noise but the
   *  avatar still says "who" at a glance. */
  showName?: boolean
  /** When set, the chip is a button (e.g. to filter the list by `login`). */
  onClick?: () => void
  /** Stable id for the interactive variants (button / link). */
  "data-testid"?: string
  className?: string
}

export function AuthorChip({
  name,
  login,
  avatar,
  handle,
  size = "sm",
  showName = true,
  onClick,
  "data-testid": testId,
  className,
}: AuthorChipProps) {
  const label = name ?? login ?? "Unknown"
  const avatarSize = size === "xs" ? "size-4" : "size-5"
  const base = cn(
    "inline-flex min-w-0 max-w-full items-center gap-1.5 font-mono text-2xs text-muted-foreground",
    className,
  )

  const inner = (
    <>
      <Avatar className={cn(avatarSize, "shrink-0")}>
        {/* With the name shown, it sits beside the image → alt stays empty;
            avatar-only, the image carries the name itself. */}
        {avatar && <AvatarImage src={avatar} alt={showName ? "" : label} />}
        {/* The primitive's fallback type is scaled for size-8 avatars; at this
            tiny scale the initials drop to the micro register (one glyph at
            size-4) or they'd overflow the circle. Image-less authors get the
            stable identity tint (house idiom — cf. people.tsx / profile.tsx)
            so a person stays recognisable across surfaces. */}
        <AvatarFallback
          className="text-2xs font-medium text-scrim-foreground"
          style={{ backgroundColor: colorForName(label) }}
        >
          {size === "xs" ? getInitials(label).charAt(0) : getInitials(label)}
        </AvatarFallback>
      </Avatar>
      {showName && <span className="truncate">{label}</span>}
    </>
  )

  // Click-to-filter wins: a button that doesn't trigger the row's stretched link.
  if (onClick) {
    return (
      <button
        type="button"
        data-testid={testId}
        // The action (filter) lives in the accessible name — a title attr is
        // unreachable for keyboard/touch users.
        aria-label={`Filter by ${label}`}
        onClick={(e) => {
          e.stopPropagation()
          onClick()
        }}
        className={cn(
          base,
          "rounded-md outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        )}
      >
        {inner}
      </button>
    )
  }

  // Known Derive user → link to their profile.
  if (handle) {
    return (
      <Link
        to="/users/$handle"
        params={{ handle }}
        data-testid={testId}
        aria-label={`View @${handle}'s profile`}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          base,
          "rounded-md outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        )}
      >
        {inner}
      </Link>
    )
  }

  // Anonymous / unmapped author: plain text, no link. Avatar-only still needs the
  // name reachable — it rides the title (and the image alt / initials fallback).
  return (
    <span className={base} title={showName ? undefined : label}>
      {inner}
    </span>
  )
}
