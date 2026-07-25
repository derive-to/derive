import { newId } from "@derive/core"
import { z } from "@hono/zod-openapi"
import { Hono } from "hono"
import type { AppContext } from "../context"
import { decryptSecret, encryptSecret } from "../lib/crypto"
import { bail, fail, readJson } from "../lib/http"

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

// The workspace-pool credential is a model_credential row keyed on this reserved sentinel
// user id, so the org's shared plan reuses the whole encrypted-secret store with no new
// table. It can never collide with a real user id (those are newId-prefixed).
const POOL_USER = "__workspace_pool__"

export const modelCredentialRoutes = (ctx: AppContext) => {
  const { meta, deps, agentFor, requireUser, requireWorkspace } = ctx
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
        kind: z.enum(["oauth", "api_key"]),
        token: z.string().min(1).max(4000),
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
        kind: z.enum(["oauth", "api_key"]),
        token: z.string().min(1).max(4000),
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

  // The executor fetches the credential a run bills against, decrypted. Priority:
  //   1. INITIATOR — the session's asker (`?session=`) or the run's `initiated_by`
  //      (`?run=`, the person who clicked Run now). "Bill mine first."
  //   2. OWNER — the agent's registrant (`created_by`), but ONLY when this agent is on the
  //      owner's lend-list (org_settings.ownerLendAgents); default off.
  //   3. WORKSPACE POOL — the org's shared plan (the sentinel-user credential row).
  //   4. none — `{ credential: null }`; the runner fails the run closed with a "connect
  //      your plan" message rather than falling back to a shared token.
  // A clock/event run has no initiator (`initiated_by` null) and resolves straight to the
  // owner/pool tiers; the boot preflight (no session/run) resolves the same tail. Isolation
  // is structural: a session/run id resolves only when it belongs to THIS agent (404
  // otherwise, so foreign ids don't leak), and only the resolved principal's row is read.
  app.get("/v1/agent/model-credential", async (c) => {
    const agent = await agentFor(c)
    if (!agent) return fail(c, 401, "agent token required")
    const provider = c.req.query("provider") ?? "claude-code"
    if (!deps.encryptionKey) return c.json({ credential: null })
    const present = (cred: { kind: string; secret: string }, source: string) =>
      c.json({
        credential: {
          kind: cred.kind,
          value: decryptSecret(cred.secret, deps.encryptionKey as string),
        },
        source,
      })
    const sessionId = c.req.query("session")
    if (sessionId) {
      const s = await meta.getSession(sessionId)
      const sctx = s ? await meta.getContext(s.context_id) : null
      if (!s || !sctx || sctx.agent_id !== agent.id || s.org_id !== agent.org_id)
        return fail(c, 404, "unknown session")
      const asker = await meta.getModelCredential(agent.org_id, s.asker_id, provider)
      if (asker) return present(asker, "asker")
    }
    const runId = c.req.query("run")
    if (runId) {
      const r = await meta.getRun(runId)
      if (!r || r.agent_id !== agent.id || r.org_id !== agent.org_id)
        return fail(c, 404, "unknown run")
      if (r.initiated_by) {
        const initiator = await meta.getModelCredential(agent.org_id, r.initiated_by, provider)
        if (initiator) return present(initiator, "initiator")
      }
    }
    // Owner tier — only when this agent is on its owner's lend-list (per-agent, default off).
    const owner = agent.created_by
    if (owner) {
      const settings = await meta.getOrgSettings(agent.org_id)
      if (settings.ownerLendAgents?.includes(agent.id)) {
        const cred = await meta.getModelCredential(agent.org_id, owner, provider)
        if (cred) return present(cred, "owner")
      }
    }
    // Workspace pool tier — the org's shared plan, if one is connected.
    const pool = await meta.getModelCredential(agent.org_id, POOL_USER, provider)
    if (pool) return present(pool, "pool")
    return c.json({ credential: null })
  })

  return app
}
