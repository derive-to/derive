/**
 * Short-lived API tokens — the agent's own authentication, usable from its shell.
 *
 * THE GAP THIS CLOSES. A hosted-OAuth agent is authenticated, but only INSIDE the
 * MCP transport: the connector holds the grant, the model's shell holds nothing. So
 * any operation that isn't an MCP tool is unreachable at the agent's real
 * authorization level, and the agent has to go find a SECOND credential for the same
 * human — a CLI login, its own scopes, its own expiry, its own rotation footguns.
 * That detour is where auth actually hurts (see lib/upload-token.ts, which solved
 * exactly this shape for one endpoint: staging bytes). This generalizes it: mint a
 * bearer over MCP, spend it with curl against any REST route, let it expire.
 *
 * WHAT IT IS NOT. Not a session, not refreshable, not a way to gain reach. It is a
 * capability: least-privilege by construction, minutes long, re-checked against live
 * membership at spend time, and re-mintable with one tool call — which is why it
 * needs no refresh mechanism at all (the rotation footgun simply isn't on this path).
 *
 * THE CEILING, three ways at once. A minted token acts at
 *   min(requested access, the grant's scope role, the user's LIVE membership role)
 * — mint time caps against the first two, and `verifyApiToken`'s caller re-checks the
 * third on every spend, so demoting or removing the human kills their outstanding
 * tokens mid-TTL. The token can never do more than the grant that minted it, and the
 * grant can never do more than the human behind it.
 *
 * HONEST LIMIT: this is stateless (no row to delete), so revoking the parent OAuth
 * grant does NOT invalidate already-minted tokens the way it invalidates the grant
 * itself — the live-membership re-check and the short TTL are what bound that window.
 * Kill an in-flight token immediately by removing the user from the workspace; a
 * standing revocation cascade would need minted tokens to be stored, which trades the
 * whole point (a cheap, stateless, mint-on-demand capability) for it.
 *
 * A thin wrapper over lib/capability-token.ts (which owns the HMAC format, key
 * caching, and the edge-safety notes) with this kind's domain and payload.
 */
import type { Role } from "@derive/core"
import { signCapabilityToken, verifyCapabilityToken } from "./capability-token"

const DOMAIN = "derive-api-token:"

/** Prefix, so bearer resolution routes without trial verification and this kind can
 *  never be confused for a run/session capability or a registered agent token. */
export const API_TOKEN_PREFIX = "dkapi_"

/** How long a minted API token stays spendable. Long enough for a working batch of
 *  curl calls, short enough that a leaked one (shell history, a pasted transcript)
 *  is a bounded liability. Deliberately the same 15 minutes as an upload URL. */
export const API_TOKEN_TTL_MS = 15 * 60 * 1000

/** The access levels a mint can request, in ascending order. These name what the
 *  holder may DO, not who they are; each maps to the workspace Role that permits it. */
export const API_TOKEN_ACCESS = ["read", "comment", "publish", "manage"] as const
export type ApiTokenAccess = (typeof API_TOKEN_ACCESS)[number]

/** The role an access level needs. `manage` is owner-grade: the level that reaches
 *  context management, agent minting, and the other rewire-the-workspace routes. */
export const roleForAccess: Record<ApiTokenAccess, Role> = {
  read: "viewer",
  comment: "commenter",
  publish: "editor",
  manage: "owner",
}

/** Is this bearer a minted API token? (Prefix only — verification is separate.) */
export const isApiToken = (bearer: string): boolean => bearer.startsWith(API_TOKEN_PREFIX)

/**
 * Sign an API token for one (user, workspace, role, client).
 *
 * @param secret      The DERIVE_AUTH_SECRET / encryptionKey
 * @param userId      The granting human — re-checked for live membership at spend time
 * @param orgId       The one workspace this token acts in
 * @param role        The already-capped role it acts with (never above the grant's)
 * @param clientId    The OAuth client whose grant minted it (provenance in the audit log)
 * @param expEpochMs  Expiry as ms since epoch (Date.now() + API_TOKEN_TTL_MS)
 */
export const signApiToken = async (
  secret: string,
  userId: string,
  orgId: string,
  role: Role,
  clientId: string,
  expEpochMs: number,
): Promise<string> =>
  `${API_TOKEN_PREFIX}${await signCapabilityToken(DOMAIN, secret, [userId, orgId, role, clientId], expEpochMs)}`

/**
 * Verify a minted API token. Returns its claims, or null on any failure (bad prefix,
 * bad signature, malformed, expired). Never throws.
 *
 * The caller MUST still re-check that `userId` is a live member of `orgId` and cap the
 * returned role by that membership — the claim records what was granted at mint time,
 * not what is true now.
 */
export const verifyApiToken = async (
  secret: string,
  token: string,
  nowMs: number,
): Promise<{ userId: string; orgId: string; role: Role; clientId: string } | null> => {
  if (!isApiToken(token)) return null
  const claim = await verifyCapabilityToken(
    DOMAIN,
    secret,
    token.slice(API_TOKEN_PREFIX.length),
    nowMs,
  )
  if (!claim) return null
  // Payload: `<userId>.<orgId>.<role>.<clientId>`. Ids and roles can't contain dots;
  // a client id theoretically can, so split the first three from the LEFT and let the
  // remainder be the client.
  const parts = claim.rest.split(".")
  if (parts.length < 4) return null
  const [userId, orgId, role, ...clientParts] = parts as [string, string, string, ...string[]]
  if (!userId || !orgId) return null
  if (role !== "viewer" && role !== "commenter" && role !== "editor" && role !== "owner")
    return null
  return { userId, orgId, role, clientId: clientParts.join(".") }
}
