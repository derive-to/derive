import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import type { AppContext } from "../context"
import { anonName, fail, readJson } from "../lib/http"

/** Live updates per artifact (SSE) + ephemeral presence (who's viewing now). */
export const realtimeRoutes = (ctx: AppContext) => {
  const { meta, bus, presence, backplane, authorize, actingUser, anonViewerId } = ctx
  const app = new Hono()

  app.get("/v1/artifacts/:shortId/events", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact))) return c.text("not found", 404)
    // A Durable Object backplane owns the stream itself (edge); relay adapters
    // (in-process, Redis) return null and we hold the SSE here.
    const direct = backplane.handleStream?.(c, artifact.id)
    if (direct) return direct
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
    // Presence identity is server-derived, never client-supplied: a signed-in
    // user or agent shows by their account name; an anonymous viewer gets a
    // stable, friendly handle (`helpful-kitty-95`) keyed to their viewer cookie,
    // so they can't impersonate anyone or spam arbitrary names. This is the only
    // thing an anonymous caller may do beyond reading (see the lockdown in app.ts).
    const name = (await actingUser(c))?.name ?? anonName(anonViewerId(c))
    const viewers = await presence.heartbeat(artifact.id, name, Date.now())
    bus.publish(artifact.id, { type: "presence", viewers })
    return c.json({ viewers })
  })

  // Live cursor: a viewer's pointer position (viewport-normalized 0..1) fanned out
  // to everyone else on the artifact. Ephemeral — never stored, never webhooked;
  // it rides the same backplane as presence, so the DO relays it across isolates.
  app.post("/v1/artifacts/:shortId/cursor", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact))) return fail(c, 404, "not found")
    const body = await readJson(
      c,
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().max(80).optional(),
        color: z.string().max(32).optional(),
        x: z.number(),
        y: z.number(),
      }),
    )
    if (body instanceof Response) return body
    const clamp = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)
    // Same server-derived identity as presence: a signed-in user/agent by their
    // account name, an anonymous viewer by their stable rando handle — never a
    // client-supplied label. So a cursor and its presence row share one identity.
    const name = (await actingUser(c))?.name ?? anonName(anonViewerId(c))
    bus.publish(artifact.id, {
      type: "cursor",
      id: body.id,
      name,
      color: body.color ?? "#655999",
      x: clamp(body.x),
      y: clamp(body.y),
    })
    return c.body(null, 204)
  })

  return app
}
