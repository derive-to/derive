// Stable per-identity tint palette for image-less avatars, so a person stays
// recognisable across comments, presence, and threads. These are raw color DATA
// (a fixed categorical identity palette), not theming — this module is allow-listed
// in scripts/check-design-tokens.mjs so the color lives here, never in a component.
const AUTHOR_TINTS = [
  "#7c6cbd",
  "#3c6e2f",
  "#a04425",
  "#2f6e6e",
  "#9a5fb0",
  "#b08322",
  "#4a63b8",
  "#9a4a6b",
] as const

// Deterministic name → tint. A simple rolling hash keeps the same person on the
// same color without storing anything.
export function colorForName(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return AUTHOR_TINTS[h % AUTHOR_TINTS.length] ?? AUTHOR_TINTS[0]
}
