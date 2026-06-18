import { Link } from "@tanstack/react-router"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { cn } from "@/lib/utils"

// One author, rendered as a tiny avatar + name — the "who last changed this" /
// "who authored this version" chip. Fields come straight off the resolved
// `author` (and the per-version author_* fields): a GitHub identity, plus the
// Dock `handle` when that committer signed into Dock.
//
// Three shapes, picked by the props:
//  - `onClick`  → a button (used to filter the list by this author).
//  - `handle`   → a Link to the author's /u/<handle> profile.
//  - neither    → plain, non-interactive text.
export interface AuthorChipProps {
  name: string | null
  login: string | null
  avatar: string | null
  /** The Dock username, when this GitHub user signed in — drives the profile link. */
  handle: string | null
  /** "sm" (default) sits in a meta line; "xs" is the tightest variant. */
  size?: "xs" | "sm"
  /** When set, the chip is a button (e.g. to filter the list by `login`). */
  onClick?: () => void
  /** Stable id for the interactive variants (button / link). */
  "data-testid"?: string
  className?: string
}

const initialsOf = (label: string): string => label.slice(0, 2).toUpperCase()

export function AuthorChip({
  name,
  login,
  avatar,
  handle,
  size = "sm",
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
        {avatar && <AvatarImage src={avatar} alt={label} />}
        <AvatarFallback>{initialsOf(label)}</AvatarFallback>
      </Avatar>
      <span className="truncate">{label}</span>
    </>
  )

  // Click-to-filter wins: a button that doesn't trigger the row's stretched link.
  if (onClick) {
    return (
      <button
        type="button"
        data-testid={testId}
        title={`Filter by ${label}`}
        onClick={(e) => {
          e.stopPropagation()
          onClick()
        }}
        className={cn(base, "rounded-md transition-colors hover:text-foreground")}
      >
        {inner}
      </button>
    )
  }

  // Known Dock user → link to their profile.
  if (handle) {
    return (
      <Link
        to="/u/$handle"
        params={{ handle }}
        data-testid={testId}
        title={`@${handle}`}
        onClick={(e) => e.stopPropagation()}
        className={cn(base, "transition-colors hover:text-foreground")}
      >
        {inner}
      </Link>
    )
  }

  // Anonymous / unmapped author: plain text, no link.
  return <span className={base}>{inner}</span>
}
