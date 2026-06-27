import { type FollowKind, GLOBAL_FOLLOW_ORG, newId, normalizeUsername } from "@dock/core"
import { type Context, Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { fail, readJson } from "../lib/http"

/** Follows (per-user: GitHub authors, repo path prefixes, and people). The followed set
 *  drives the `scope=following` activity feed in GET /v1/artifacts. Author/path follows
 *  are scoped to the caller's active workspace; people (`user`) follows are global
 *  (org_id = "*"). All endpoints require a signed-in user. */
export const followRoutes = (ctx: AppContext) => {
  const { meta, currentUser, activeWorkspace } = ctx
  const app = new Hono()

  // Author targets are normalized to lowercase so they match the (lowercased)
  // author_login comparison in followedArtifactIds; path targets are kept verbatim.
  const normalizeTarget = (kind: FollowKind, target: string): string =>
    kind === "author" ? target.trim().toLowerCase() : target.trim()

  const followBody = z.object({
    kind: z.enum(["author", "path", "user"]),
    target: z.string().min(1, "target is required"),
  })

  // Resolve a follow request to its stored (target, org_id). For a person-follow the
  // client sends a username; we resolve it to the user id (kept off the wire) and store
  // it globally. Self-follow and unknown handles are rejected. Returns a Response on error.
  const resolve = async (
    c: Context,
    me: { id: string },
    b: { kind: FollowKind; target: string },
  ): Promise<{ target: string; orgId: string; followedUserId?: string } | Response> => {
    if (b.kind === "user") {
      const profile = await meta.getUserByUsername(normalizeUsername(b.target))
      if (!profile) return fail(c, 404, "no profile with that username")
      if (profile.id === me.id) return fail(c, 400, "you can't follow yourself")
      return { target: profile.id, orgId: GLOBAL_FOLLOW_ORG, followedUserId: profile.id }
    }
    const target = normalizeTarget(b.kind, b.target)
    if (!target) return fail(c, 400, "target is required")
    return { target, orgId: await activeWorkspace(c) }
  }

  app.get("/v1/follows", async (c) => {
    const me = await currentUser(c)
    if (!me) return fail(c, 401, "unauthenticated")
    const org = await activeWorkspace(c)
    const follows = await meta.listFollows(me.id, org)
    // Resolve each people-follow's target id → a public handle so the client can render
    // it (and match follow-state by username) without ever holding a raw user id. One
    // batched lookup; author/path follows pass through untouched. The internal id is
    // REPLACED by the handle in `target` on the way out — it never reaches the client.
    const userIds = follows.filter((f) => f.kind === "user").map((f) => f.target)
    const byId = new Map(
      userIds.length ? (await meta.getUsers(userIds)).map((u) => [u.id, u] as const) : [],
    )
    return c.json({
      follows: follows.map((f) => {
        if (f.kind !== "user") return f
        const u = byId.get(f.target)
        const handle = u?.username ?? null
        // target := the public handle (not the internal user id). The client keys
        // people-follows by handle everywhere; the raw id stays server-side.
        return {
          ...f,
          target: handle ?? "",
          handle,
          name: u?.name ?? null,
          image: u?.image ?? null,
        }
      }),
    })
  })

  app.post("/v1/follows", async (c) => {
    const me = await currentUser(c)
    if (!me) return fail(c, 401, "unauthenticated")
    const b = await readJson(c, followBody)
    if (b instanceof Response) return b
    const r = await resolve(c, me, b)
    if (r instanceof Response) return r
    const follow = await meta.addFollow({
      id: newId("fl"),
      org_id: r.orgId,
      user_id: me.id,
      kind: b.kind,
      target: r.target,
    })
    // Tell the followed person someone followed them (no artifact anchor).
    if (r.followedUserId && r.followedUserId !== me.id) {
      await meta.createNotification({
        id: newId("ntf"),
        user_id: r.followedUserId,
        actor: me.username ?? me.name ?? "Someone",
        kind: "follow",
        artifact_id: "",
        artifact_short_id: "",
        artifact_title: null,
        thread_id: "",
        comment_id: "",
        preview: "started following you",
      })
    }
    return c.json({ follow }, 201)
  })

  app.delete("/v1/follows", async (c) => {
    const me = await currentUser(c)
    if (!me) return fail(c, 401, "unauthenticated")
    const b = await readJson(c, followBody)
    if (b instanceof Response) return b
    const r = await resolve(c, me, b)
    if (r instanceof Response) return r
    await meta.removeFollow(me.id, r.orgId, b.kind, r.target)
    return c.body(null, 204)
  })

  return app
}
