/** Two-letter initials for an avatar fallback — first two characters of the
 *  resolved label (name, handle, or email), uppercased. Callers pass the already
 *  chosen label, e.g. `initials(user.name ?? user.username)`; an empty label
 *  yields the fallback. Centralized so the whole app derives initials one way. */
export const getInitials = (label: string | null | undefined, fallback = "?"): string => {
  const s = (label ?? "").trim()
  return s ? s.slice(0, 2).toUpperCase() : fallback
}

/** A single-letter monogram for a small chrome tile (e.g. a collection glyph in
 *  the nav rail, sized to the icon slot where two letters wouldn't fit). First
 *  character of the trimmed label, uppercased; an empty label yields the fallback.
 *  Kept beside getInitials so the app derives leading glyphs one way. */
export const getMonogram = (label: string | null | undefined, fallback = "?"): string => {
  const s = (label ?? "").trim()
  // First code POINT (Array.from splits by code point), so an emoji or astral-plane
  // leading char stays whole instead of rendering half a surrogate pair.
  return s ? (Array.from(s)[0] ?? fallback).toUpperCase() : fallback
}
