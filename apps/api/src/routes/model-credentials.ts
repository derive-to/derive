import { newId } from "@derive/core"
import { z } from "@hono/zod-openapi"
import { type Context, Hono } from "hono"
import type { AppContext } from "../context"
import { decryptSecret, encryptSecret, sha256 } from "../lib/crypto"
import { bail, fail, readJson } from "../lib/http"
import { fallbackPayerTiers, POOL_USER } from "../lib/payer"

// Model-plan credentials. Every team member connects their OWN Claude/Codex plan token (or
// an API key), encrypted at rest (lib/crypto, keyed by DERIVE_AUTH_SECRET). A workspace may
// also connect a shared POOL plan (one sentinel-user row per org). Surfaces:
//   - personal (session): a user manages their own credential, one per provider.
//   - workspace pool (session, admin): an admin manages the org's shared plan.
//   - owner-lend (session, owner): an agent's owner opts THAT agent in to bill the owner's
//     own plan as a fallback (per-agent, default off).
//   - agent (bearer): the executor fetches the credential a run BILLS, resolved in priority
//     initiator -> owner (if this agent is lent) -> workspace pool -> fail-closed. Never an
//     unrelated user's: session lookups are bound to the calling agent's own context.

const PROVIDERS = ["claude-code", "codex"] as const
const isoNow = () => new Date().toISOString()

// The workspace-pool credential is a model_credential row keyed on a reserved sentinel user
// id, so the org's shared plan reuses the whole encrypted-secret store with no new table. It
// can never collide with a real user id (those are newId-prefixed). Defined in lib/payer.ts,
// which owns the payer chain — this route resolves it for an in-flight run, and the enqueue
// preflight resolves it before creating work; the two must agree.

export const modelCredentialRoutes = (ctx: AppContext) => {
  const { meta, deps, agentFor, agentRunScope, agentSessionScope, requireUser, requireWorkspace } =
    ctx
  const app = new Hono()

  // List the caller's own connected credentials — HINTS only, never the secret.
  app.get("/v1/me/model-credentials", async (c) => {
    const org = await requireWorkspace(c, "read")
    if (org instanceof Response) return org
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const creds = await meta.listModelCredentials(org, me.id)
    return c.json({
      credentials: creds.map((cr) => ({
        provider: cr.provider,
        kind: cr.kind,
        hint: cr.hint,
        updated_at: cr.updated_at,
      })),
    })
  })

  // Connect / replace the caller's own plan token for a provider (encrypt + upsert).
  app.post("/v1/me/model-credentials", async (c) => {
    const org = await requireWorkspace(c, "read")
    if (org instanceof Response) return org
    const me = await requireUser(c)
    if (me instanceof Response) return me
    if (!deps.encryptionKey) return fail(c, 503, "secret encryption is not configured")
    const b = await readJson(
      c,
      z.object({
        provider: z.enum(PROVIDERS),
        kind: z.enum(["oauth", "api_key", "login"]),
        token: z.string().min(1).max(16000),
      }),
    )
    if (b instanceof Response) return bail(b)
    const token = b.token.trim()
    if (token === "") return fail(c, 400, "token is empty")
    const now = isoNow()
    const hint = token.slice(-4)
    await meta.setModelCredential({
      id: newId("mcr"),
      org_id: org,
      user_id: me.id,
      provider: b.provider,
      kind: b.kind,
      secret: encryptSecret(token, deps.encryptionKey),
      hint,
      created_at: now,
      updated_at: now,
    })
    return c.json({ ok: true, provider: b.provider, hint }, 201)
  })

  // Disconnect the caller's own credential for a provider.
  app.delete("/v1/me/model-credentials/:provider", async (c) => {
    const org = await requireWorkspace(c, "read")
    if (org instanceof Response) return org
    const me = await requireUser(c)
    if (me instanceof Response) return me
    await meta.deleteModelCredential(org, me.id, c.req.param("provider"))
    return c.body(null, 204)
  })

  // ---- Workspace pool (admin) --------------------------------------------
  // The org's SHARED plan: billed when a run's initiator has no plan and the agent isn't
  // owner-lent. One sentinel-user credential row per provider — same encrypted-secret store.

  app.get("/v1/workspace/model-credentials", async (c) => {
    const org = await requireWorkspace(c, "manage")
    if (org instanceof Response) return org
    const creds = await meta.listModelCredentials(org, POOL_USER)
    return c.json({
      credentials: creds.map((cr) => ({
        provider: cr.provider,
        kind: cr.kind,
        hint: cr.hint,
        updated_at: cr.updated_at,
      })),
    })
  })

  app.post("/v1/workspace/model-credentials", async (c) => {
    const org = await requireWorkspace(c, "manage")
    if (org instanceof Response) return org
    if (!deps.encryptionKey) return fail(c, 503, "secret encryption is not configured")
    const b = await readJson(
      c,
      z.object({
        provider: z.enum(PROVIDERS),
        kind: z.enum(["oauth", "api_key", "login"]),
        token: z.string().min(1).max(16000),
      }),
    )
    if (b instanceof Response) return bail(b)
    const token = b.token.trim()
    if (token === "") return fail(c, 400, "token is empty")
    const now = isoNow()
    const hint = token.slice(-4)
    await meta.setModelCredential({
      id: newId("mcr"),
      org_id: org,
      user_id: POOL_USER,
      provider: b.provider,
      kind: b.kind,
      secret: encryptSecret(token, deps.encryptionKey),
      hint,
      created_at: now,
      updated_at: now,
    })
    return c.json({ ok: true, provider: b.provider, hint }, 201)
  })

  app.delete("/v1/workspace/model-credentials/:provider", async (c) => {
    const org = await requireWorkspace(c, "manage")
    if (org instanceof Response) return org
    await meta.deleteModelCredential(org, POOL_USER, c.req.param("provider"))
    return c.body(null, 204)
  })

  // ---- Owner-lend (per agent, owner only) --------------------------------
  // An agent's OWNER opts THAT agent in to bill the owner's own plan as a fallback.
  // Membership lives in org_settings.ownerLendAgents (an attribute on the existing JSON, no
  // new column). Only the agent's own owner (created_by) may toggle it.

  app.get("/v1/workspace/owner-lend", async (c) => {
    const org = await requireWorkspace(c, "manage")
    if (org instanceof Response) return org
    const settings = await meta.getOrgSettings(org)
    return c.json({ agentIds: settings.ownerLendAgents ?? [] })
  })

  app.put("/v1/workspace/owner-lend/:agentId", async (c) => {
    const org = await requireWorkspace(c, "manage")
    if (org instanceof Response) return org
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const agentId = c.req.param("agentId")
    const agent = (await meta.listAgents(org)).find((a) => a.id === agentId)
    if (!agent) return fail(c, 404, "unknown agent")
    if (agent.created_by !== me.id)
      return fail(c, 403, "only the agent's owner can lend their plan")
    const b = await readJson(c, z.object({ enabled: z.boolean() }))
    if (b instanceof Response) return bail(b)
    const settings = await meta.getOrgSettings(org)
    const lent = new Set(settings.ownerLendAgents ?? [])
    if (b.enabled) lent.add(agentId)
    else lent.delete(agentId)
    await meta.setOrgSettings(org, { ...settings, ownerLendAgents: [...lent] })
    return c.json({ ok: true, agentId, enabled: b.enabled })
  })

  // The ordered credential candidates a run bills against — {userId, source} for each tier
  // that applies, in priority order: INITIATOR (session asker / run `initiated_by`), then the
  // agent OWNER (only when this agent is on org_settings.ownerLendAgents; default off), then
  // the WORKSPACE POOL (a sentinel-user row). Returns a Response (404) when a passed
  // session/run id doesn't belong to THIS agent, so foreign ids never leak or bill. Shared by
  // the read (GET) and the refreshed-token write (PUT) so both target the same rows.
  const credentialCandidates = async (
    c: Context,
    agent: { id: string; org_id: string; created_by: string | null },
  ) => {
    const out: { userId: string; source: string }[] = []
    // PIN TO THE BEARER'S OWN WORK FIRST. Belonging to the same agent is not enough: one
    // agent serves many sessions from many askers and many runs from many initiators, so
    // "same agent" let an executor name someone ELSE's session and be handed that person's
    // decrypted plan token — and, through the PUT below, overwrite their stored login (the
    // compare-and-swap is satisfied by the value it just read). A capability bearer may only
    // ever ask about the one item its token names.
    const runScope = agentRunScope(c)
    const sessScope = agentSessionScope(c)
    if (runScope && c.req.query("session")) return fail(c, 403, "run token: pass ?run= only")
    if (sessScope && c.req.query("run")) return fail(c, 403, "session token: pass ?session= only")
    if (runScope && c.req.query("run") && c.req.query("run") !== runScope)
      return fail(c, 403, "a run token may only resolve its own run")
    if (sessScope && c.req.query("session") && c.req.query("session") !== sessScope)
      return fail(c, 403, "a session token may only resolve its own session")

    const sessionId = c.req.query("session")
    if (sessionId) {
      const s = await meta.getSession(sessionId)
      // Contextless sessions have no owning agent, so an agent cannot resolve their credential.
      const sctx = s?.context_id ? await meta.getContext(s.context_id) : null
      if (!s || !sctx || sctx.agent_id !== agent.id || s.org_id !== agent.org_id)
        return fail(c, 404, "unknown session")
      out.push({ userId: s.asker_id, source: "asker" })
    }
    const runId = c.req.query("run")
    if (runId) {
      const r = await meta.getRun(runId)
      if (!r || r.agent_id !== agent.id || r.org_id !== agent.org_id)
        return fail(c, 404, "unknown run")
      if (r.initiated_by) out.push({ userId: r.initiated_by, source: "initiator" })
    }
    // The tiers after the initiator (owner-lend, then the pool) come from lib/payer.ts, so the
    // enqueue preflight refuses exactly the work this would later fail to pay for.
    out.push(...(await fallbackPayerTiers(meta, agent.org_id, agent.id, agent.created_by)))
    return out
  }

  // A `v1.` secret that decrypts to itself never decrypted (decryptSecret FAILS OPEN on a
  // wrong key / corrupt blob): treat it as unreadable rather than inject ciphertext as a token.
  const unreadable = (cred: { secret: string }, value: string) =>
    cred.secret.startsWith("v1.") && value === cred.secret

  // The executor fetches the credential a run bills against, decrypted — the FIRST readable
  // candidate tier. `reason` distinguishes an UNREADABLE stored secret (reconnect) from
  // nothing connected (connect). A credential whose secret won't decrypt is treated as absent,
  // never a 500.
  app.get("/v1/agent/model-credential", async (c) => {
    const agent = await agentFor(c)
    if (!agent) return fail(c, 401, "agent token required")
    const provider = c.req.query("provider") ?? "claude-code"
    const key = deps.encryptionKey
    if (!key) return c.json({ credential: null, reason: "none" })
    const candidates = await credentialCandidates(c, agent)
    if (candidates instanceof Response) return candidates
    let sawUnreadable = false
    for (const { userId, source } of candidates) {
      const cred = await meta.getModelCredential(agent.org_id, userId, provider)
      if (!cred) continue
      const value = decryptSecret(cred.secret, key)
      if (unreadable(cred, value)) {
        sawUnreadable = true
        continue
      }
      return c.json({ credential: { kind: cred.kind, value }, source })
    }
    return c.json({ credential: null, reason: sawUnreadable ? "unreadable" : "none" })
  })

  // The executor PERSISTS a refreshed login blob back to the EXACT row a run resolved to.
  // Codex rotates its login's single-use token in place and writes it to auth.json during a
  // run; the runner reads that back and PUTs it here so the stored token stays valid for the
  // next run (the sanctioned "run and persist the updated auth.json" pattern, not a
  // reimplemented refresh). Hardened four ways, because a runtime bearer must never be able to
  // rewrite a management-owned secret:
  //   - BOUND TO A RUN: a `?session=`/`?run=` that belongs to THIS agent is required, so a
  //     contextless bearer can't reach the owner/pool tiers and overwrite them.
  //   - EXACT TIER: `source` names the tier the run read; we write only that row, never a
  //     re-resolved "first readable" (which could drift to another principal mid-run).
  //   - LOGIN ONLY: only the self-rotating `login` kind is refreshable; an api_key/oauth
  //     secret is never clobbered.
  //   - COMPARE-AND-SWAP: we overwrite only if the stored secret still hashes to what the run
  //     started with (`prev_sha256`), so a concurrent/stale write or a mid-run row replacement
  //     is rejected. The blob must also parse as a non-empty object (a crashed CLI can leave
  //     garbage).
  app.put("/v1/agent/model-credential", async (c) => {
    const agent = await agentFor(c)
    if (!agent) return fail(c, 401, "agent token required")
    const provider = c.req.query("provider") ?? "claude-code"
    const key = deps.encryptionKey
    if (!key) return fail(c, 503, "secret encryption is not configured")
    if (!c.req.query("session") && !c.req.query("run"))
      return fail(c, 400, "a session or run is required to persist a refresh")
    const b = await readJson(
      c,
      z.object({
        token: z.string().min(1).max(16000),
        source: z.enum(["asker", "initiator", "owner", "pool"]),
        prev_sha256: z.string().min(1).max(64),
      }),
    )
    if (b instanceof Response) return bail(b)
    const candidates = await credentialCandidates(c, agent)
    if (candidates instanceof Response) return candidates
    const target = candidates.find((x) => x.source === b.source)
    if (!target) return fail(c, 404, "unknown credential tier")
    const cred = await meta.getModelCredential(agent.org_id, target.userId, provider)
    if (!cred) return c.json({ ok: false, reason: "no credential to update" }, 404)
    if (cred.kind !== "login") return fail(c, 409, "only login credentials are refreshable")
    const current = decryptSecret(cred.secret, key)
    if (unreadable(cred, current) || sha256(current) !== b.prev_sha256)
      return c.json({ ok: false, reason: "credential changed" }, 409)
    const token = b.token.trim()
    try {
      const parsed = JSON.parse(token)
      if (!parsed || typeof parsed !== "object" || Object.keys(parsed).length === 0)
        return fail(c, 400, "not a valid login blob")
    } catch {
      return fail(c, 400, "not a valid login blob")
    }
    await meta.setModelCredential({
      ...cred,
      secret: encryptSecret(token, key),
      updated_at: isoNow(),
    })
    return c.json({ ok: true })
  })

  return app
}
