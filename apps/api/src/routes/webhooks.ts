import { randomUUID } from "node:crypto"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { fail, readJson } from "../lib/http"
import { isPublicHttpUrl } from "../lib/net"
import { WEBHOOK_EVENTS, type WebhookEvent } from "../webhooks"

/** Outbound webhooks (Slack + signed generic) — the workspace's notification
 *  integrations, Admin-managed. URLs are SSRF-filtered; secrets never leave. */
export const webhookRoutes = (ctx: AppContext) => {
  const { meta, deps, workspaceCan, activeWorkspace } = ctx
  const app = new Hono()

  const publicWebhook = (w: { secret: string }) => ({ ...w, secret: undefined })

  app.get("/v1/webhooks", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const hooks = await meta.listWebhooks(await activeWorkspace(c))
    return c.json({ webhooks: hooks.map(publicWebhook) })
  })

  app.post("/v1/webhooks", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const org = await activeWorkspace(c)
    const b = await readJson(c, z.object({}).catchall(z.unknown()))
    if (b instanceof Response) return b
    if (typeof b.url !== "string" || !isPublicHttpUrl(b.url))
      return fail(c, 400, "a valid public http(s) url is required")
    const kind = b.kind === "slack" ? "slack" : "generic"
    // events: array or "*"; validate against the known set
    const events =
      Array.isArray(b.events) && b.events.length
        ? b.events
            .filter((e): e is WebhookEvent =>
              (WEBHOOK_EVENTS as readonly string[]).includes(e as string),
            )
            .join(",")
        : "*"
    let artifactRef: string | null = null
    if (typeof b.artifact === "string" && b.artifact) {
      const a = await meta.getByShortId(b.artifact)
      if (!a || a.org_id !== org) return fail(c, 404, "artifact not found")
      artifactRef = a.id
    }
    const created = await meta.createWebhook({
      id: `wh_${randomUUID().slice(0, 12)}`,
      org_id: org,
      artifact_id: artifactRef,
      url: b.url,
      secret: typeof b.secret === "string" && b.secret ? b.secret : randomUUID().replace(/-/g, ""),
      kind,
      events,
      label: typeof b.label === "string" ? b.label : null,
    })
    return c.json(publicWebhook(created), 201)
  })

  app.delete("/v1/webhooks/:id", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    await meta.deleteWebhook(c.req.param("id"), await activeWorkspace(c))
    return c.body(null, 204)
  })

  app.get("/v1/webhooks/:id/deliveries", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const w = await meta.getWebhook(c.req.param("id"), await activeWorkspace(c))
    if (!w) return fail(c, 404, "not found")
    const rows = await meta.recentDeliveries(w.id, 20)
    return c.json({
      deliveries: rows.map((d) => ({
        id: d.id,
        event_type: d.event_type,
        status: d.status,
        attempts: d.attempts,
        last_error: d.last_error,
        created_at: d.created_at,
      })),
    })
  })

  // Send a sample event to a webhook so you can confirm it lands.
  app.post("/v1/webhooks/:id/test", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const w = await meta.getWebhook(c.req.param("id"), await activeWorkspace(c))
    if (!w) return fail(c, 404, "not found")
    const sample = JSON.stringify({
      event: "version.published",
      at: new Date().toISOString(),
      artifact: {
        short_id: "sample00",
        title: "Test artifact",
        url: `${deps.baseUrl}/artifacts/sample00`,
      },
      data: { version: 1, message: "test delivery from Derive", author: "derive" },
    })
    await meta.enqueueDelivery({
      id: `wd_${randomUUID().slice(0, 12)}`,
      webhook_id: w.id,
      url: w.url,
      secret: w.secret,
      kind: w.kind,
      event_type: "version.published",
      payload: sample,
    })
    return c.json({ queued: true })
  })

  return app
}
