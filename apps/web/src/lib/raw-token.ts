// Leave enough life for the iframe navigation and a bundle's relative assets to start.
// A capability closer to expiry is refreshed before any raw request is made.
const RAW_TOKEN_REFRESH_MARGIN_MS = 15_000

// Compatibility with a briefly mixed frontend/backend deploy: an older API does not
// return raw_token_expires_at. A record fetched in the normal 30-second query freshness
// window is safe (the server guarantees every newly minted token at least three minutes
// of life); anything older is refreshed before use.
const LEGACY_DETAIL_FRESH_MS = 30_000

/** Whether a cached artifact detail's raw-content capability must be refreshed before
 * mounting the sandboxed iframe. `fetchedAt` is React Query's dataUpdatedAt. */
export const rawTokenNeedsRefresh = (
  expiresAt: string | undefined,
  fetchedAt: number,
  now: number = Date.now(),
): boolean => {
  const expires = expiresAt ? Date.parse(expiresAt) : Number.NaN
  if (Number.isFinite(expires)) return expires <= now + RAW_TOKEN_REFRESH_MARGIN_MS
  return fetchedAt <= 0 || now - fetchedAt > LEGACY_DETAIL_FRESH_MS
}
