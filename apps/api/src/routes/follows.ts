import { type FollowKind, newId } from "@dock/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { fail, readJson } from "../lib/http"

/** Follows (per-user: track GitHub authors + repo path prefixes). The followed set
 *  drives the `scope=following` activity feed in GET /v1/artifacts. Workspace-scoped
 *  to the caller's active workspace; all endpoints require a signed-in user. */
export const followRoutes = (ctx: AppContext) => {
  const { meta, currentUser, activeWorkspace } = ctx
  const app = new Hono()

  // Author (GitHub login) + user (Dock handle) targets are lowercased to match the
  // lowercased comparisons in followedArtifactIds; path targets are kept verbatim.
  const normalizeTarget = (kind: FollowKind, target: string): string =>
    kind === "path" ? target.trim() : target.trim().toLowerCase()

  const followBody = z.object({
    kind: z.enum(["author", "path", "user"]),
    target: z.string().min(1, "target is required"),
  })

  app.get("/v1/follows", async (c) => {
    const me = await currentUser(c)
    if (!me) return fail(c, 401, "unauthenticated")
    const org = await activeWorkspace(c)
    return c.json({ follows: await meta.listFollows(me.id, org) })
  })

  app.post("/v1/follows", async (c) => {
    const me = await currentUser(c)
    if (!me) return fail(c, 401, "unauthenticated")
    const b = await readJson(c, followBody)
    if (b instanceof Response) return b
    const target = normalizeTarget(b.kind, b.target)
    if (!target) return fail(c, 400, "target is required")
    const org = await activeWorkspace(c)
    const follow = await meta.addFollow({
      id: newId("fl"),
      org_id: org,
      user_id: me.id,
      kind: b.kind,
      target,
    })
    return c.json({ follow }, 201)
  })

  app.delete("/v1/follows", async (c) => {
    const me = await currentUser(c)
    if (!me) return fail(c, 401, "unauthenticated")
    const b = await readJson(c, followBody)
    if (b instanceof Response) return b
    const target = normalizeTarget(b.kind, b.target)
    if (!target) return fail(c, 400, "target is required")
    const org = await activeWorkspace(c)
    await meta.removeFollow(me.id, org, b.kind, target)
    return c.body(null, 204)
  })

  return app
}
