import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import type { AppContext } from "../context"
import { readJson } from "../lib/http"

/** In-app notifications (the header bell) for the signed-in user. */
export const notificationRoutes = (ctx: AppContext) => {
  const { meta, bus, backplane, requireUser, currentUser } = ctx
  const app = new Hono()

  app.get("/v1/notifications", async (c) => {
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const [notifications, unread] = await Promise.all([
      meta.listNotifications(me.id, 50),
      meta.unreadNotificationCount(me.id),
    ])
    return c.json({ notifications, unread })
  })

  app.post("/v1/notifications/read", async (c) => {
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const body = await readJson(
      c,
      z.object({ all: z.boolean().optional(), ids: z.array(z.string()).optional() }),
    )
    if (body instanceof Response) return body
    const ids = body.all === true ? "all" : (body.ids ?? [])
    await meta.markNotificationsRead(me.id, ids)
    const unread = await meta.unreadNotificationCount(me.id)
    return c.json({ unread })
  })

  // Live notification stream for the signed-in user (the header bell subscribes).
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
