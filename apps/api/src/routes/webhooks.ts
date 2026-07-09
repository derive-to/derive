import { randomUUID } from "node:crypto"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { bail, fail, readJson } from "../lib/http"
import { isPublicHttpUrl } from "../lib/net"
import { WEBHOOK_EVENTS, type WebhookEvent } from "../webhooks"

/** Outbound webhooks (Slack + signed generic) — the workspace's notification
 *  integrations, Admin-managed. URLs are SSRF-filtered; secrets never leave. The
 *  Webhook + Delivery response schemas are the single source for the web client's
 *  types (generated from the OpenAPI spec). */
export const webhookRoutes = (ctx: AppContext) => {
  const { meta, deps, workspaceCan, activeWorkspace } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  // Strip the signing secret on the way out, preserving every other field's type (so the
  // response type-checks against the Webhook schema). Omitting the key ⇒ absent in JSON,
  // same as the old `secret: undefined`.
  const publicWebhook = <T extends { secret: string }>({
    secret: _secret,
    ...rest
  }: T): Omit<T, "secret"> => rest

  // The webhook as it goes out — the stored row minus its signing secret. (org_id +
  // the emptied secret ride along at runtime but aren't part of the client contract.)
  const Webhook = z
    .object({
      id: z.string(),
      artifact_id: z
        .string()
        .nullable()
        .describe(
          "The artifact this webhook is scoped to, or null to fire on all workspace events",
        ),
      url: z.string().describe("The destination endpoint deliveries are POSTed to"),
      kind: z
        .enum(["generic", "slack"])
        .describe("Delivery format: generic posts signed JSON, slack posts a Block Kit message"),
      events: z.string().describe('Comma-separated event types to deliver, or "*" for all events'),
      label: z.string().nullable().describe("Optional human-readable label, or null if unnamed"),
      active: z
        .union([z.literal(0), z.literal(1)])
        .describe("Whether deliveries are enabled (1) or paused (0)"),
      created_at: z.string(),
    })
    .openapi("Webhook")

  const Delivery = z
    .object({
      id: z.string(),
      event_type: z.string(),
      status: z
        .enum(["pending", "delivered", "dead"])
        .describe(
          "Delivery state: pending (awaiting/retrying), delivered (succeeded), dead (gave up)",
        ),
      attempts: z.number().describe("Number of delivery attempts made so far"),
      last_error: z
        .string()
        .nullable()
        .describe("The most recent failure message, or null if none"),
      created_at: z.string(),
    })
    .openapi("Delivery")

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/webhooks",
      tags: ["Webhooks"],
      summary: "List the workspace's webhooks (Admin only).",
      responses: {
        200: {
          description: "The workspace's webhooks, without their signing secrets.",
          content: { "application/json": { schema: z.object({ webhooks: z.array(Webhook) }) } },
        },
      },
    }),
    async (c) => {
      if (!(await workspaceCan(c, "manage"))) return bail(fail(c, 403, "forbidden"))
      const hooks = await meta.listWebhooks(await activeWorkspace(c))
      return c.json({ webhooks: hooks.map(publicWebhook) })
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/webhooks",
      tags: ["Webhooks"],
      summary: "Create a webhook (Admin only).",
      responses: {
        201: {
          description: "The created webhook, without its signing secret.",
          content: { "application/json": { schema: Webhook } },
        },
      },
    }),
    async (c) => {
      if (!(await workspaceCan(c, "manage"))) return bail(fail(c, 403, "forbidden"))
      const org = await activeWorkspace(c)
      const b = await readJson(
        c,
        z.object({
          url: z.string().optional(),
          kind: z.string().optional(),
          events: z.array(z.string()).optional(),
          artifact: z.string().optional(),
          secret: z.string().optional(),
          label: z.string().optional(),
        }),
      )
      if (b instanceof Response) return bail(b)
      if (!b.url || !isPublicHttpUrl(b.url))
        return bail(fail(c, 400, "a valid public http(s) url is required"))
      const kind = b.kind === "slack" ? "slack" : "generic"
      // events: an explicit subset (filtered to the known set), else "*" (all).
      const events = b.events?.length
        ? b.events
            .filter((e): e is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(e))
            .join(",")
        : "*"
      let artifactRef: string | null = null
      if (b.artifact) {
        const a = await meta.getByShortId(b.artifact)
        if (!a || a.org_id !== org) return bail(fail(c, 404, "artifact not found"))
        artifactRef = a.id
      }
      const created = await meta.createWebhook({
        id: `wh_${randomUUID().slice(0, 12)}`,
        org_id: org,
        artifact_id: artifactRef,
        url: b.url,
        secret: b.secret || randomUUID().replace(/-/g, ""),
        kind,
        events,
        label: b.label ?? null,
      })
      return c.json(publicWebhook(created), 201)
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/webhooks/{id}",
      tags: ["Webhooks"],
      summary: "Delete a webhook (Admin only).",
      request: { params: z.object({ id: z.string() }) },
      responses: { 204: { description: "The webhook was deleted." } },
    }),
    async (c) => {
      if (!(await workspaceCan(c, "manage"))) return bail(fail(c, 403, "forbidden"))
      await meta.deleteWebhook(c.req.param("id"), await activeWorkspace(c))
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/webhooks/{id}/deliveries",
      tags: ["Webhooks"],
      summary: "Recent delivery attempts for a webhook (Admin only).",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The 20 most recent delivery attempts.",
          content: { "application/json": { schema: z.object({ deliveries: z.array(Delivery) }) } },
        },
      },
    }),
    async (c) => {
      if (!(await workspaceCan(c, "manage"))) return bail(fail(c, 403, "forbidden"))
      const w = await meta.getWebhook(c.req.param("id"), await activeWorkspace(c))
      if (!w) return bail(fail(c, 404, "not found"))
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
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/webhooks/{id}/test",
      tags: ["Webhooks"],
      summary: "Send a sample event to a webhook so you can confirm it lands (Admin only).",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The sample delivery was queued.",
          content: { "application/json": { schema: z.object({ queued: z.boolean() }) } },
        },
      },
    }),
    async (c) => {
      if (!(await workspaceCan(c, "manage"))) return bail(fail(c, 403, "forbidden"))
      const w = await meta.getWebhook(c.req.param("id"), await activeWorkspace(c))
      if (!w) return bail(fail(c, 404, "not found"))
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
    },
  )

  return app
}
