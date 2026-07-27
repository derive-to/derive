import { newId, type PlanRecord } from "@derive/core"
import { z } from "@hono/zod-openapi"
import { Hono } from "hono"
import type { AppContext } from "../context"
import { encryptSecret } from "../lib/crypto"
import { bail, fail, readJson } from "../lib/http"

// WO2 — bring-your-own plans. An owner attaches their own model or broker credential; runs
// meter against it (personal → workspace pool → loud failure). Derive holds the gate and the
// ledger, never the meter. Secrets are encrypted at rest and NEVER surfaced on read.

const LIMITS = z.object({ monthlyMicroUsd: z.number().int().positive() }).strict().optional()

/** Present a plan WITHOUT its secret. `scope` + `monthly_micro_usd` describe the plan and its
 *  budget without ever leaking the credential. */
const present = (p: PlanRecord) => {
  let monthly: number | null = null
  if (p.limits) {
    try {
      monthly = (JSON.parse(p.limits) as { monthlyMicroUsd?: number }).monthlyMicroUsd ?? null
    } catch {}
  }
  return {
    id: p.id,
    org_id: p.org_id,
    user_id: p.user_id,
    kind: p.kind,
    provider: p.provider,
    scope: p.user_id ? "personal" : "workspace",
    monthly_micro_usd: monthly,
    created_at: p.created_at,
  }
}

export const planRoutes = (ctx: AppContext) => {
  const { meta, requireUser, requireWorkspace, deps } = ctx
  const app = new Hono()

  app.get("/v1/plans", async (c) => {
    const org = await requireWorkspace(c, "read")
    if (org instanceof Response) return org
    return c.json({ plans: (await meta.listPlans(org)).map(present) })
  })

  app.post("/v1/plans", async (c) => {
    const b = await readJson(
      c,
      z.object({
        kind: z.enum(["model", "broker"]),
        provider: z.string().min(1).max(64),
        secret: z.string().min(1).max(4096),
        scope: z.enum(["personal", "workspace"]).default("personal"),
        limits: LIMITS,
      }),
    )
    if (b instanceof Response) return bail(b)
    // Anyone in the workspace can attach a PERSONAL plan; a workspace POOL plan needs manage.
    const org = await requireWorkspace(c, b.scope === "workspace" ? "manage" : "read")
    if (org instanceof Response) return org
    const me = await requireUser(c)
    if (me instanceof Response) return me
    if (!deps.encryptionKey) return fail(c, 500, "encryption key not configured")
    const rec = await meta.createPlan({
      id: newId("plan"),
      org_id: org,
      user_id: b.scope === "workspace" ? null : me.id,
      kind: b.kind,
      provider: b.provider,
      secret_enc: encryptSecret(b.secret, deps.encryptionKey),
      limits: b.limits ? JSON.stringify(b.limits) : null,
    })
    return c.json(present(rec), 201)
  })

  app.delete("/v1/plans/:id", async (c) => {
    const org = await requireWorkspace(c, "read")
    if (org instanceof Response) return org
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const p = await meta.getPlan(c.req.param("id"))
    if (!p || p.org_id !== org) return fail(c, 404, "not found")
    // You can remove your OWN personal plan; a pool plan (or someone else's) needs manage.
    if (p.user_id !== me.id) {
      const gate = await requireWorkspace(c, "manage")
      if (gate instanceof Response) return gate
    }
    await meta.deletePlan(p.id, org)
    return c.body(null, 204)
  })

  return app
}
