import { type AgentRecord, capRole, type MetaStore, type Role } from "@derive/core"
import { createLocalJWKSet, type JWTPayload, jwtVerify } from "jose"
import type { Auth } from "../auth-config"
import { sha256 } from "./crypto"

/** What a valid OAuth access token resolves to: the synthetic agent record (a workspace
 *  principal) plus the id of the user who granted the consent. `rec.role` is already
 *  capped by the owner's membership role in `rec.org_id`; `scopeRole` keeps the uncapped
 *  scope-derived role so an X-Derive-Workspace re-home can re-cap against the TARGET
 *  workspace's membership instead of compounding caps. */
export interface OauthAgentResolution {
  rec: AgentRecord
  ownerId: string
  scopeRole: Role
  /** The OAuth client this grant belongs to (keys the granted-workspace set). */
  clientId: string
  /** The workspaces this grant is scoped to (the consent multi-select). EMPTY =
   *  "all workspaces" — the grant reaches every workspace the owner belongs to.
   *  A non-empty set restricts every resolution: default org, X-Derive-Workspace
   *  re-home, and the MCP list_workspaces/switch surface all clamp to it. */
  boundWorkspaces: string[]
}

interface OauthAgentDeps {
  meta: MetaStore
  auth: Auth | undefined
  baseUrl: string
  /** The accepted RFC 8707 audiences (see auth-config `mcpAudiences`). A JWT access token
   *  is accepted only when its `aud` is one of these — the MCP-spec MUST that a resource
   *  server rejects tokens not issued for it, mirroring the AS-side `validAudiences`. */
  audiences: string[]
  /** Find (or provision) the granting user's personal workspace — the agent runs there. */
  provisionPersonal: (me: { id: string; email: string; name: string | null }) => Promise<string>
}

/**
 * OAuth access-token → scoped-agent resolution, quarantining the jose/JWKS dependency out
 * of the request context. Handles both the browser consent flow's opaque tokens and the
 * RFC 8707 JWTs that remote MCP clients present. `agentFor` (in context) dispatches to the
 * returned `oauthAgent` after ruling out a registered agent token.
 */
export function makeOauthAgent({
  meta,
  auth,
  baseUrl,
  audiences,
  provisionPersonal,
}: OauthAgentDeps) {
  // The least-privilege role an OAuth-granted scope set maps to: publish/review earn
  // editor; propose/comment earn commenter; read alone is viewer.
  // derive:manage maps to owner-grade, but scopeRole is always capped by the
  // grantor's ACTUAL membership role (capRole below) — the scope can widen what
  // the grant may attempt, never what the human could do themselves.
  const roleFromScopes = (scopes: string[]): Role =>
    scopes.includes("derive:manage")
      ? "owner"
      : scopes.includes("derive:publish") || scopes.includes("derive:review")
        ? "editor"
        : scopes.includes("derive:propose") || scopes.includes("derive:comment")
          ? "commenter"
          : "viewer"

  // The DEFAULT workspace the agent runs in (headerless resolution), the owner's
  // membership role there (the cap on the scope-derived role), and the grant's
  // reachable SET. Precedence: the workspaces the user ticked on the consent
  // screen — keyed (user, client), each honored only while they're still a member
  // — narrowing to the first of that set; else all their workspaces, first one;
  // else a personal workspace provisioned on first touch (the user owns it). An
  // EMPTY set is "all workspaces": the default is simply their first.
  const oauthWorkspace = async (
    userId: string,
    clientId: string,
    email: string | null,
    name: string | null,
  ): Promise<{ org: string; memberRole: Role; bound: string[] }> => {
    const [mine, bound] = await Promise.all([
      meta.listWorkspaces(userId),
      clientId ? meta.getOAuthClientWorkspaces(userId, clientId) : Promise.resolve([]),
    ])
    // The grant's reachable workspaces the user is STILL a member of. A non-empty
    // `bound` restricts; an empty one means every workspace they belong to.
    const scoped = bound.length ? mine.filter((w) => bound.includes(w.id)) : mine
    const target = scoped[0] ?? mine[0]
    if (target) return { org: target.id, memberRole: target.role, bound }
    const org = await provisionPersonal({ id: userId, email: email ?? "", name })
    return { org, memberRole: "owner", bound }
  }

  // Our own JWKS (served by the jwt plugin at /api/auth/jwks), read straight from
  // Better Auth's store on this instance — NOT an HTTP self-fetch, which a
  // Cloudflare Worker can't do against its own hostname. The local key set is
  // cached per isolate, rebuilt on a verify miss (a rotated signing key).
  const oauthIssuer = new URL("/api/auth", baseUrl).toString()
  let jwksCache: ReturnType<typeof createLocalJWKSet> | null = null
  const loadJwks = async () => {
    const res = (await auth?.api.getJwks()) as Parameters<typeof createLocalJWKSet>[0] | undefined
    return res?.keys?.length ? createLocalJWKSet(res) : null
  }

  // An OAuth access token (granted via the consent screen) acts as a scoped agent:
  // it runs in the granting user's workspace, authors as the client's name, and
  // takes a role derived from the granted derive:* scopes. Expired/invalid tokens
  // resolve to nothing — the caller is then anonymous (read-only), never the owner.
  const oauthAgent = async (token: string): Promise<OauthAgentResolution | null> => {
    // 1. Opaque access token (the `derive login` flow): stored hashed (sha256, like
    //    agent tokens), so resolve by the hash of the presented bearer.
    const grant = await meta.getOAuthGrant(sha256(token))
    if (grant) {
      if (grant.expiresAt.getTime() <= Date.now()) return null
      const ws = await oauthWorkspace(grant.userId, grant.clientId, grant.userEmail, grant.userName)
      const scopeRole = roleFromScopes(grant.scopes)
      return {
        ownerId: grant.userId,
        scopeRole,
        clientId: grant.clientId,
        boundWorkspaces: ws.bound,
        rec: {
          id: `oauth:${grant.clientId}`,
          org_id: ws.org,
          name: grant.clientName,
          token: "",
          // Scopes propose the role; the owner's membership in the resolved
          // workspace is the ceiling (a publish scope is not an editorship in a
          // workspace where the granting user is only a viewer).
          role: capRole(scopeRole, ws.memberRole),
          created_by: grant.userId,
          // An OAuth grant is never hosted directly: hosting means a registered
          // agent record (a grant has no server-storable credential to run with).
          hosted: 0,
          managed: 0,
          created_at: new Date().toISOString(),
        },
      }
    }
    // 2. JWT access token: the oauth-provider issues a signed JWT (not stored in our
    //    table) when a client sends an RFC 8707 `resource` indicator — which every
    //    remote MCP client (Claude Code, claude.ai) does. Verify it against our own
    //    JWKS and resolve the agent from its claims.
    if (token.split(".").length === 3) return oauthAgentFromJwt(token)
    return null
  }

  const oauthAgentFromJwt = async (token: string): Promise<OauthAgentResolution | null> => {
    const verify = async (): Promise<JWTPayload | null> => {
      jwksCache ??= await loadJwks()
      if (!jwksCache) return null
      // Validate the audience (RFC 8707), not just the issuer + signature: a token this
      // AS minted for a DIFFERENT resource must be rejected here (the MCP-spec MUST). jose
      // passes when the token's `aud` matches any accepted audience. Legitimately-minted MCP
      // tokens carry aud ∈ audiences (== the AS-side validAudiences), so this only rejects
      // foreign-audience tokens.
      return (await jwtVerify(token, jwksCache, { issuer: oauthIssuer, audience: audiences }))
        .payload
    }
    let claims: JWTPayload | null
    try {
      claims = await verify()
    } catch {
      // Bad signature/issuer/expiry — or a rotated key the cache misses. Rebuild
      // the key set once and retry before giving up.
      jwksCache = null
      try {
        claims = await verify()
      } catch {
        return null
      }
    }
    if (!claims) return null
    const userId = typeof claims.sub === "string" ? claims.sub : ""
    if (!userId) return null
    const scopes = String(claims.scope ?? "")
      .split(/\s+/)
      .filter(Boolean)
    const clientId = String(claims.azp ?? claims.client_id ?? "")
    const u = (await meta.getUsers([userId]))[0]
    const ws = await oauthWorkspace(userId, clientId, u?.email ?? null, u?.name ?? null)
    const scopeRole = roleFromScopes(scopes)
    return {
      ownerId: userId,
      scopeRole,
      clientId,
      boundWorkspaces: ws.bound,
      rec: {
        id: `oauth:${clientId}`,
        org_id: ws.org,
        name: (await meta.getOAuthClientName(clientId)) || clientId || "An agent",
        token: "",
        role: capRole(scopeRole, ws.memberRole),
        created_by: userId,
        // Never hosted directly, same as the opaque-token branch above.
        hosted: 0,
        managed: 0,
        created_at: new Date().toISOString(),
      },
    }
  }

  return { oauthAgent }
}
