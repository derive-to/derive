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
}

interface OauthAgentDeps {
  meta: MetaStore
  auth: Auth | undefined
  baseUrl: string
  /** Find (or provision) the granting user's personal workspace — the agent runs there. */
  provisionPersonal: (me: { id: string; email: string; name: string | null }) => Promise<string>
}

/**
 * OAuth access-token → scoped-agent resolution, quarantining the jose/JWKS dependency out
 * of the request context. Handles both the browser consent flow's opaque tokens and the
 * RFC 8707 JWTs that remote MCP clients present. `agentFor` (in context) dispatches to the
 * returned `oauthAgent` after ruling out a registered agent token.
 */
export function makeOauthAgent({ meta, auth, baseUrl, provisionPersonal }: OauthAgentDeps) {
  // The least-privilege role an OAuth-granted scope set maps to: publish/review earn
  // editor; propose/comment earn commenter; read alone is viewer.
  const roleFromScopes = (scopes: string[]): Role =>
    scopes.includes("derive:publish") || scopes.includes("derive:review")
      ? "editor"
      : scopes.includes("derive:propose") || scopes.includes("derive:comment")
        ? "commenter"
        : "viewer"

  // The workspace the agent runs in, and the owner's membership role there (the
  // cap on the scope-derived role). Precedence: the workspace the user picked on
  // the consent screen — keyed (user, client), honored only while they're still a
  // member — then the first workspace (pre-picker grants), then a personal
  // workspace provisioned on first touch exactly as the user's own first request
  // would (multi mode, lazy; the user owns it).
  const oauthWorkspace = async (
    userId: string,
    clientId: string,
    email: string | null,
    name: string | null,
  ): Promise<{ org: string; memberRole: Role }> => {
    const mine = await meta.listWorkspaces(userId)
    const bound = clientId ? await meta.getOAuthClientWorkspace(userId, clientId) : null
    const target = bound ? mine.find((w) => w.id === bound) : undefined
    if (target) return { org: target.id, memberRole: target.role }
    if (mine[0]) return { org: mine[0].id, memberRole: mine[0].role }
    const org = await provisionPersonal({ id: userId, email: email ?? "", name })
    return { org, memberRole: "owner" }
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
        rec: {
          id: `oauth:${grant.clientId}`,
          org_id: ws.org,
          name: grant.clientName,
          token: "",
          // Scopes propose the role; the owner's actual membership caps it. Without
          // the cap, publish-scoped grants would act as editor in a workspace where
          // the granting user is only a viewer.
          role: capRole(scopeRole, ws.memberRole) ?? "viewer",
          created_by: grant.userId,
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
      return (await jwtVerify(token, jwksCache, { issuer: oauthIssuer })).payload
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
      rec: {
        id: `oauth:${clientId}`,
        org_id: ws.org,
        name: (await meta.getOAuthClientName(clientId)) || clientId || "An agent",
        token: "",
        role: capRole(scopeRole, ws.memberRole) ?? "viewer",
        created_by: userId,
        created_at: new Date().toISOString(),
      },
    }
  }

  return { oauthAgent }
}
