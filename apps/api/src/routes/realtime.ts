import { effectiveRole } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import type { BlankEnv } from "hono/types"
import type { Viewer } from "../bus"
import type { AppContext } from "../context"
import { anonName, bail, fail, readJson } from "../lib/http"

/** Live updates per artifact (SSE) + ephemeral presence (who's viewing now). The
 *  Viewer response schema is the single source for the web client's type; the SSE
 *  event stream stays a plain route. */
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
  const app = new OpenAPIHono<BlankEnv>()

  const ViewerSchema = z
    .object({ id: z.string(), name: z.string(), role: z.string().nullable() })
    .openapi("Viewer")

  // Server-derived presence identity (never client-supplied): a signed-in user by
  // their public @handle, an anonymous viewer by a stable friendly handle keyed to
  // their viewer cookie (no PII, no impersonation). `role` is their effective role on
  // this artifact, so name/role can't be forged either. Shared by the SSE-lifecycle
  // presence (join/leave) and the heartbeat backstop.
  const deriveViewer = async (
    c: Context,
    artifact: Parameters<typeof actorFor>[1],
  ): Promise<Viewer> => {
    const me = await currentUser(c)
    const role = effectiveRole(
      await actorFor(c, artifact),
      artifact.workspace_access,
      artifact.link_role,
    )
    return me
      ? { id: me.id, name: me.username ?? "someone", role }
      : { id: anonViewerId(c), name: anonName(anonViewerId(c)), role }
  }
  // Per-connection key so a viewer's multiple tabs ref-count correctly on the
  // in-process backplane (the DO keys presence on the stream object itself).
  let streamSeq = 0

  // Live event stream — SSE, so it stays a plain route (not typed JSON).
  app.get("/v1/artifacts/:shortId/events", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact))) return c.text("not found", 404)
    const viewer = await deriveViewer(c, artifact)
    // A Durable Object backplane owns the stream itself (edge) AND tracks presence off
    // its connect/disconnect lifecycle; relay adapters (the in-process bus) return null,
    // so we hold the SSE here and drive presence around it.
    const direct = backplane.handleStream?.(c, artifact.id, viewer)
    if (direct) return direct
    c.header("Access-Control-Allow-Origin", "*")
    const streamKey = `s${++streamSeq}`
    return streamSSE(c, async (stream) => {
      const unsub = bus.subscribe(artifact.id, (e) => {
        void stream.writeSSE({ event: e.type, data: JSON.stringify(e) })
      })
      // Present for as long as this stream stays open; leave the moment it aborts —
      // so a tab-close reflects for everyone in ~a second, not after the TTL.
      bus.publish(artifact.id, {
        type: "presence",
        viewers: await presence.join(artifact.id, viewer, streamKey, Date.now()),
      })
      stream.onAbort(async () => {
        unsub()
        bus.publish(artifact.id, {
          type: "presence",
          viewers: await presence.leave(artifact.id, viewer.id, streamKey, Date.now()),
        })
      })
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

  // Presence heartbeat — the TTL-backstopped keep-alive. Most viewers are tracked by
  // their live /events stream (join/leave above); this keeps a streamless caller (or a
  // viewer between reconnects) on the roster, and stays anon-allowed — the one write an
  // anonymous viewer may do beyond reading (lockdown in app.ts).
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/presence",
      tags: ["Realtime"],
      summary: "Presence heartbeat — keep this viewer on the artifact's roster.",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        200: {
          description: "The current viewers on this artifact.",
          content: { "application/json": { schema: z.object({ viewers: z.array(ViewerSchema) }) } },
        },
      },
    }),
    async (c) => {
      const artifact = await meta.getByShortId(c.req.param("shortId"))
      if (!artifact || !(await authorize(c, "read", artifact)))
        return bail(fail(c, 404, "not found"))
      const viewer = await deriveViewer(c, artifact)
      const viewers = await presence.heartbeat(artifact.id, viewer, Date.now())
      bus.publish(artifact.id, { type: "presence", viewers })
      return c.json({ viewers })
    },
  )

  // Live cursor: a viewer's pointer position (viewport-normalized 0..1) fanned out
  // to everyone else on the artifact. Ephemeral — never stored, never webhooked.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/cursor",
      tags: ["Realtime"],
      summary: "Broadcast a live cursor frame to the artifact's other viewers.",
      request: { params: z.object({ shortId: z.string() }) },
      responses: { 204: { description: "Fanned out (ephemeral; nothing stored)." } },
    }),
    async (c) => {
      const artifact = await meta.getByShortId(c.req.param("shortId"))
      if (!artifact || !(await authorize(c, "read", artifact)))
        return bail(fail(c, 404, "not found"))
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
      if (body instanceof Response) return bail(body)
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
        emoji: kind === "emoji" ? body.emoji : undefined,
        gone: body.gone === true ? true : undefined,
        tap: body.tap === true ? true : undefined,
        slide: body.slide,
        x: clamp(body.x),
        y: clamp(body.y),
      })
      return c.body(null, 204)
    },
  )

  return app
}
