import { newId } from "@derive/core"
import { z } from "@hono/zod-openapi"
import { Hono } from "hono"
import type { AppContext } from "../context"
import { decryptSecret, encryptSecret } from "../lib/crypto"
import { bail, fail, readJson } from "../lib/http"

// Per-user model-plan credentials. Every team member connects their OWN Claude/Codex plan
// token (or an API key) here; it is encrypted at rest (lib/crypto, keyed by DERIVE_AUTH_SECRET)
// and used ONLY for that user's own agent runs. Two surfaces:
//   - personal (session): a user manages their own credential, one per provider.
//   - agent (bearer): the executor fetches the calling agent's OWNER's credential to run on
//     that user's plan. Scoped to the caller-agent's registrant — never another user's.

const PROVIDERS = ["claude-code", "codex"] as const
const isoNow = () => new Date().toISOString()

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

  // The executor fetches the calling agent's OWNER's credential for a provider, decrypted, so
  // it can run on that user's plan. Returns `{ credential: null }` when the owner has none —
  // the runner fails the run closed with a "connect your plan" message rather than falling back
  // to a shared token. Isolation is structural: only the caller-agent's registrant's row is read.
  app.get("/v1/agent/model-credential", async (c) => {
    const agent = await agentFor(c)
    if (!agent) return fail(c, 401, "agent token required")
    const provider = c.req.query("provider") ?? "claude-code"
    const owner = agent.created_by
    if (!owner || !deps.encryptionKey) return c.json({ credential: null })
    const cred = await meta.getModelCredential(agent.org_id, owner, provider)
    if (!cred) return c.json({ credential: null })
    return c.json({
      credential: { kind: cred.kind, value: decryptSecret(cred.secret, deps.encryptionKey) },
    })
  })

  return app
}
