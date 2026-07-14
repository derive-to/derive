/**
 * Short-lived publish-access tokens for POST /v1/artifacts/t/:token and
 * .../versions/t/:token.
 *
 * Minted by the MCP `stage_publish` tool for the same reason `stage_asset`
 * exists: a hosted-OAuth agent's credential lives INSIDE the MCP transport, so
 * its shell has no bearer to publish with — and a large file (a designed HTML
 * page, a bundle with big assets) can't ride the `publish` tool's inline
 * `content`/`files` because that content is generated as model output, capped
 * by the per-response token ceiling and forced into slow multi-turn chunking.
 * This token moves the publish capability out to the shell: mint it over MCP,
 * `curl -F file=@…` the bytes to the tokened route. The file never passes
 * through the model's context.
 *
 * A publish token is a BIGGER capability than an upload token (it writes
 * artifacts, not inert blobs), so it is scoped tightly:
 *   - bound to the granting USER, whose live membership is re-checked at spend
 *     time — demoting or removing them kills outstanding URLs (like the authed
 *     route's per-request role check), and the publish is attributed to them.
 *   - bound to a TARGET: "*" authorizes creating ONE-OR-MORE new artifacts in
 *     the workspace; a specific short_id authorizes revising ONLY that artifact.
 *     A leaked create-token can't overwrite existing work; a leaked
 *     revise-token can't touch anything but its one artifact.
 *
 * A thin wrapper over lib/capability-token.ts (which owns the HMAC format, key
 * caching, and edge-safety notes) with this kind's domain and its
 * `<orgId>.<userId>.<target>` payload.
 */
import { signCapabilityToken, verifyCapabilityToken } from "./capability-token"

const DOMAIN = "derive-publish-token:"

/** How long a minted publish URL stays spendable — long enough to zip and push
 *  a prototype, short enough that a leaked URL is a bounded liability. */
export const PUBLISH_TOKEN_TTL_MS = 15 * 60 * 1000

/** Sentinel `target` for a token that authorizes creating new artifacts. */
export const PUBLISH_TARGET_CREATE = "*"

/**
 * Sign a publish token.
 *
 * @param secret      The DERIVE_AUTH_SECRET / encryptionKey
 * @param orgId       The workspace the publish lands in
 * @param userId      The granting user — re-checked for live publish rights at
 *                    spend time, and attributed as the author/owner
 * @param target      PUBLISH_TARGET_CREATE to create new artifacts, or a
 *                    short_id to revise exactly that one
 * @param expEpochMs  Expiry as ms since epoch (Date.now() + PUBLISH_TOKEN_TTL_MS)
 */
export const signPublishToken = (
  secret: string,
  orgId: string,
  userId: string,
  target: string,
  expEpochMs: number,
): Promise<string> => signCapabilityToken(DOMAIN, secret, [orgId, userId, target], expEpochMs)

/**
 * Verify a publish token. Returns the workspace, the granting user, and the
 * target ("*" or a short_id), or null (bad signature, malformed, expired).
 * Never throws.
 */
export const verifyPublishToken = async (
  secret: string,
  token: string,
  nowMs: number,
): Promise<{ orgId: string; userId: string; target: string } | null> => {
  const claim = await verifyCapabilityToken(DOMAIN, secret, token, nowMs)
  if (!claim) return null
  // Payload: `<orgId>.<userId>.<target>`. target and userId are dot-free (a
  // short_id / "*" and a u_ id); split them off the right, orgId keeps the rest
  // (defensive — ws_ ids are dot-free too, but this never truncates one).
  const parts = claim.rest.split(".")
  if (parts.length < 3) return null
  const target = parts[parts.length - 1]
  const userId = parts[parts.length - 2]
  const orgId = parts.slice(0, -2).join(".")
  if (!orgId || !userId || !target) return null
  return { orgId, userId, target }
}
