/** Two-letter initials for an avatar fallback — first two characters of the
 *  resolved label (name, handle, or email), uppercased. Callers pass the already
 *  chosen label, e.g. `initials(user.name ?? user.username)`; an empty label
 *  yields the fallback. Centralized so the whole app derives initials one way. */
export const getInitials = (label: string | null | undefined, fallback = "?"): string => {
  const s = (label ?? "").trim()
  return s ? s.slice(0, 2).toUpperCase() : fallback
}
