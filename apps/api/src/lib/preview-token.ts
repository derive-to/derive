/**
 * Short-lived preview-access tokens for the /raw/:shortId/v/:n/pv/:pv/* route.
 * Used by the screenshot renderer to load private/gated artifacts without
 * embedding long-lived credentials. Grants read of exactly one
 * artifact+version; never widens anything else.
 *
 * A thin wrapper over lib/capability-token.ts (which owns the HMAC format,
 * key caching, and the edge-safety notes) with this kind's domain and its
 * `<artifactId>.<n>` payload.
 */
import { signCapabilityToken, verifyCapabilityToken } from "./capability-token"

const DOMAIN = "derive-preview-token:"

/**
 * Sign a preview token that authorizes read of exactly one artifact+version.
 *
 * @param secret      The DERIVE_AUTH_SECRET / encryptionKey
 * @param artifactId  The canonical artifact UUID (not the shortId)
 * @param n           The version number (1-based integer)
 * @param expEpochMs  Expiry as ms since epoch (Date.now() + ttl)
 * @returns           A compact opaque token string (async — must be awaited)
 */
export const signPreviewToken = (
  secret: string,
  artifactId: string,
  n: number,
  expEpochMs: number,
): Promise<string> => signCapabilityToken(DOMAIN, secret, [artifactId, String(n)], expEpochMs)

/**
 * Verify a preview token. Returns the artifact id + version if valid, or null
 * (bad signature, malformed, expired). Never throws.
 *
 * @param secret  The DERIVE_AUTH_SECRET / encryptionKey
 * @param token   The token string produced by signPreviewToken
 * @param nowMs   Current time in ms (Date.now()); injectable for testing
 */
export const verifyPreviewToken = async (
  secret: string,
  token: string,
  nowMs: number,
): Promise<{ artifactId: string; n: number } | null> => {
  const claim = await verifyCapabilityToken(DOMAIN, secret, token, nowMs)
  if (!claim) return null
  // Payload: `<artifactId>.<n>` — split from the right so artifactId is
  // allowed to contain dots (defensive).
  const midDot = claim.rest.lastIndexOf(".")
  if (midDot <= 0) return null
  const n = Number(claim.rest.slice(midDot + 1))
  if (!Number.isInteger(n)) return null
  return { artifactId: claim.rest.slice(0, midDot), n }
}
