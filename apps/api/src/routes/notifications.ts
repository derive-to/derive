import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import { streamSSE } from "hono/streaming"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { bail, readJson } from "../lib/http"

/** In-app notifications (the header bell) for the signed-in user. The Notification
 *  response schema is the single source for the web client's `Notification` type
 *  (generated from the OpenAPI spec). */
export const notificationRoutes = (ctx: AppContext) => {
  const { meta, bus, backplane, requireUser, currentUser } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  const Notification = z
    .object({
      id: z.string(),
      user_id: z.string().describe("The recipient this notification belongs to"),
      actor: z
        .string()
        .describe("Who triggered it; for follow/publish this is the person's @handle"),
      kind: z
        .enum(["mention", "comment", "share", "follow", "publish", "review"])
        .describe("What happened: mention, comment, share, follow, publish, or review"),
      artifact_id: z.string(),
      artifact_short_id: z
        .string()
        .describe("The artifact's public short id for links; empty for follows (no anchor)"),
      artifact_title: z
        .string()
        .nullable()
        .describe("The artifact's title, or null if untitled or not artifact-anchored"),
      thread_id: z.string().describe("The comment thread anchor; empty when not comment-related"),
      comment_id: z
        .string()
        .describe("The specific comment anchor; empty when not comment-related"),
      preview: z.string().describe("Short text preview shown in the notification bell"),
      read: z
        .union([z.literal(0), z.literal(1)])
        .describe("Whether the user has read it: 0 unread, 1 read"),
      created_at: z.string(),
    })
    .openapi("Notification")

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/notifications",
      tags: ["Notifications"],
      summary: "List the signed-in user's recent notifications and unread count.",
      responses: {
        200: {
          description: "The 50 most recent notifications and the current unread count.",
          content: {
            "application/json": {
              schema: z.object({ notifications: z.array(Notification), unread: z.number() }),
            },
          },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const [notifications, unread] = await Promise.all([
        meta.listNotifications(me.id, 50),
        meta.unreadNotificationCount(me.id),
      ])
      return c.json({ notifications, unread })
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/notifications/read",
      tags: ["Notifications"],
      summary: "Mark notifications read (all, or a set of ids); returns the new unread count.",
      responses: {
        200: {
          description: "The unread count after marking.",
          content: { "application/json": { schema: z.object({ unread: z.number() }) } },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const body = await readJson(
        c,
        z.object({ all: z.boolean().optional(), ids: z.array(z.string()).optional() }),
      )
      if (body instanceof Response) return bail(body)
      const ids = body.all === true ? "all" : (body.ids ?? [])
      await meta.markNotificationsRead(me.id, ids)
      const unread = await meta.unreadNotificationCount(me.id)
      return c.json({ unread })
    },
  )

  // Live notification stream for the signed-in user (the header bell subscribes). SSE, not
  // JSON — kept a plain route (the OpenAPI spec describes typed JSON responses only).
  app.get("/v1/notifications/events", async (c) => {
    const me = await currentUser(c)
    if (!me) return c.text("unauthenticated", 401)
    const userId = me.id
    const direct = backplane.handleStream?.(c, `u:${userId}`)
    if (direct) return direct
    c.header("Access-Control-Allow-Origin", "*")
    return streamSSE(c, async (stream) => {
      const unsub = bus.subscribe(`u:${userId}`, (e) => {
        void stream.writeSSE({ event: e.type, data: JSON.stringify(e) })
      })
      stream.onAbort(unsub)
      await stream.writeSSE({ event: "ready", data: "{}" })
      while (!stream.aborted) {
        await stream.sleep(15000)
        await stream.writeSSE({ event: "ping", data: "{}" })
      }
    })
  })

  return app
}
