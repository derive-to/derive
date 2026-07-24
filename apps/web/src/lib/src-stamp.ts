// Signup-source refinement. The API's capture middleware stamps a `d_src` cookie
// on every external arrival (kind `artifact_visit`); clicking a growth surface
// (the footer badge, "Make your own") rewrites it with the SPECIFIC surface, so
// the funnel can tell which element converted. Last touch wins, matching the
// server's own rule. The format is owned by apps/api/src/lib/attribution.ts
// (parseSrcCookie reads this back at signup) — change it there first.

const MAX_AGE_S = 30 * 24 * 3600

/** The full `document.cookie` assignment string (pure, testable half). */
export const srcCookieString = (kind: string, artifact: string | null, path: string): string => {
  const value = encodeURIComponent(
    JSON.stringify({ k: kind, ...(artifact ? { a: artifact } : {}), p: path.slice(0, 200) }),
  )
  return `d_src=${value}; path=/; max-age=${MAX_AGE_S}; SameSite=Lax`
}

/** Stamp the surface at click time. Safe to call and forget — the nav proceeds
 *  regardless, and a signed-in user's later signup simply never reads it. */
export const stampSrc = (kind: string, artifact?: string | null): void => {
  const secure = window.location.protocol === "https:" ? "; Secure" : ""
  document.cookie = srcCookieString(kind, artifact ?? null, window.location.pathname) + secure
}
