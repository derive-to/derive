import { effectiveRole } from "@derive/core"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import type { Viewer } from "../bus"
import type { AppContext } from "../context"
import { anonName, fail, readJson } from "../lib/http"

/** Live updates per artifact (SSE) + ephemeral presence (who's viewing now). */
export const realtimeRoutes = (ctx: AppContext) => {
  const {
    meta,
    bus,
    presence,
    backplane,
    authorize,
    actingUser,
    currentUser,
    actorFor,
    anonViewerId,
  } = ctx
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
    // Presence identity is built entirely server-side, never client-supplied: a
    // signed-in user by their account (name + email), an anonymous viewer by a
    // stable, friendly handle (`helpful-kitty-95`) keyed to their viewer cookie and
    // no email, so nobody can impersonate or spam names. `role` is their effective
    // role on this artifact (so email/role can't be forged either). Presence is the
    // only thing an anonymous caller may do beyond reading (lockdown in app.ts).
    const me = await currentUser(c)
    const role = effectiveRole(await actorFor(c, artifact), artifact.visibility)
    const viewer: Viewer = me
      ? // Handle-based identity, never PII: presence reaches anonymous co-viewers and
        // rides the wildcard-CORS /events SSE. Always the public @handle (every account
        // has one post-migration); never any part of the email, even the local-part.
        { id: me.id, name: me.username ?? "someone", role }
      : { id: anonViewerId(c), name: anonName(anonViewerId(c)), role }
    const viewers = await presence.heartbeat(artifact.id, viewer, Date.now())
    bus.publish(artifact.id, { type: "presence", viewers })
    return c.json({ viewers })
  })

  // Live cursor: a viewer's pointer position (viewport-normalized 0..1) fanned out
  // to everyone else on the artifact. Ephemeral — never stored, never webhooked;
  // it rides the same backplane as presence, so the DO relays it across isolates.
  //
  // The same frame also carries the viewer's chosen style (`kind` + `emoji`, a
  // cosmetic preference) and two one-shot signals: `gone` (the viewer blurred /
  // went idle — peers drop the cursor at once instead of waiting for it to go
  // stale) and `tap` (the viewer clicked — peers pulse a ripple there). Style and
  // signals are length/enum-bounded; identity (`name`) stays server-derived.
  app.post("/v1/artifacts/:shortId/cursor", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact))) return fail(c, 404, "not found")
    const body = await readJson(
      c,
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().max(80).optional(),
        color: z.string().max(32).optional(),
        kind: z.enum(["arrow", "emoji"]).optional(),
        emoji: z.string().max(16).optional(),
        gone: z.boolean().optional(),
        tap: z.boolean().optional(),
        slide: z.number().int().min(0).optional(),
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
    const kind = body.kind ?? "arrow"
    bus.publish(artifact.id, {
      type: "cursor",
      id: body.id,
      name,
      color: body.color ?? "#655999",
      kind,
      // Only forward the glyph when the emoji style is actually selected.
      emoji: kind === "emoji" ? body.emoji : undefined,
      // Coerce to a strict, present-only boolean so a frame is either a leave/tap
      // or it isn't — peers branch on truthiness without inspecting the value.
      gone: body.gone === true ? true : undefined,
      tap: body.tap === true ? true : undefined,
      // Deck slide the viewer is on, so peers hide cursors that aren't on this slide.
      slide: body.slide,
      x: clamp(body.x),
      y: clamp(body.y),
    })
    return c.body(null, 204)
  })

  return app
}
