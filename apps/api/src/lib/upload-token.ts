/**
 * Short-lived upload-access tokens for POST /v1/assets/t/:token.
 *
 * Minted by the MCP `stage_asset` tool for agents whose only credential lives
 * INSIDE the MCP transport (hosted OAuth): the model can call tools but its
 * shell holds no bearer token, so the plain POST /v1/assets — the blessed
 * images-without-base64 path — 403s on it. This token moves that capability
 * out to the shell: mint it over MCP, spend it with curl --data-binary, and
 * the bytes never ride through the model's context.
 *
 * Grants exactly one thing: staging assets into one workspace until expiry.
 * It can't read anything, and what it writes is bounded the same as the authed
 * route (sniffed non-executable formats, 25MB cap, the workspace storage quota).
 * The token also names the USER whose grant minted it, so the spend side can
 * re-check live membership — demoting or removing the person kills their
 * outstanding upload URLs immediately, matching the per-request role check the
 * authed route does. (An ownerless legacy agent mints with an empty principal;
 * for those the mint-time role check is all there is, same as before.)
 *
 * A thin wrapper over lib/capability-token.ts (which owns the HMAC format,
 * key caching, and the edge-safety notes) with this kind's domain and its
 * `<orgId>.<userId>` payload.
 */
import { signCapabilityToken, verifyCapabilityToken } from "./capability-token"

const DOMAIN = "derive-upload-token:"

/** How long a minted upload URL stays spendable. Long enough for an agent to
 *  stage a batch of screenshots in one working session, short enough that a
 *  leaked URL (shell history, a pasted transcript) is a bounded liability. */
export const UPLOAD_TOKEN_TTL_MS = 15 * 60 * 1000

/**
 * Sign an upload token that authorizes staging assets into one workspace.
 *
 * @param secret      The DERIVE_AUTH_SECRET / encryptionKey
 * @param orgId       The workspace the staged assets belong to
 * @param userId      The granting user, re-checked for live membership at spend
 *                    time ("" for an ownerless legacy agent — no re-check)
 * @param expEpochMs  Expiry as ms since epoch (Date.now() + UPLOAD_TOKEN_TTL_MS)
 * @returns           A compact opaque token string (async — must be awaited)
 */
export const signUploadToken = (
  secret: string,
  orgId: string,
  userId: string,
  expEpochMs: number,
): Promise<string> => signCapabilityToken(DOMAIN, secret, [orgId, userId], expEpochMs)

/**
 * Verify an upload token. Returns the workspace it stages into and the user
 * whose membership must still allow publishing (empty string = no principal,
 * skip the re-check), or null (bad signature, malformed, expired). Never throws.
 *
 * @param secret  The DERIVE_AUTH_SECRET / encryptionKey
 * @param token   The token string produced by signUploadToken
 * @param nowMs   Current time in ms (Date.now()); injectable for testing
 */
export const verifyUploadToken = async (
  secret: string,
  token: string,
  nowMs: number,
): Promise<{ orgId: string; userId: string } | null> => {
  const claim = await verifyCapabilityToken(DOMAIN, secret, token, nowMs)
  if (!claim) return null
  // Payload: `<orgId>.<userId>` — split from the right so orgId is allowed to
  // contain dots (defensive; user ids can't, ws_/u_ ids don't today).
  const midDot = claim.rest.lastIndexOf(".")
  if (midDot <= 0) return null
  return { orgId: claim.rest.slice(0, midDot), userId: claim.rest.slice(midDot + 1) }
}
