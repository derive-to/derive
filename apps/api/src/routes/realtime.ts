import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import type { AppContext } from "../context"
import { fail } from "../lib/http"

/** Live updates per artifact (SSE) + ephemeral presence (who's viewing now). */
export const realtimeRoutes = (ctx: AppContext) => {
  const { meta, bus, presence, authorize } = ctx
  const app = new Hono()

  app.get("/v1/artifacts/:shortId/events", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact))) return c.text("not found", 404)
    c.header("Access-Control-Allow-Origin", "*")
    return streamSSE(c, async (stream) => {
      const unsub = bus.subscribe(artifact.id, (e) => {
        void stream.writeSSE({ event: e.type, data: JSON.stringify(e) })
      })
      stream.onAbort(unsub)
      await stream.writeSSE({
        event: "ready",
        data: JSON.stringify({ short_id: artifact.short_id }),
      })
      while (!stream.aborted) {
        await stream.sleep(15000)
        await stream.writeSSE({ event: "ping", data: "{}" })
      }
    })
  })

  app.post("/v1/artifacts/:shortId/presence", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact))) return fail(c, 404, "not found")
    const body = (await c.req.json().catch(() => ({}))) as { name?: string }
    const name = typeof body.name === "string" && body.name ? body.name : "anonymous"
    const viewers = presence.heartbeat(artifact.id, name, Date.now())
    bus.publish(artifact.id, { type: "presence", viewers })
    return c.json({ viewers })
  })

  return app
}
