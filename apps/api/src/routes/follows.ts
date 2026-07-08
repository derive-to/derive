import { type FollowKind, GLOBAL_FOLLOW_ORG, newId, normalizeUsername } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { bail, fail, readJson } from "../lib/http"

/** Follows (per-user: GitHub authors, repo path prefixes, and people). The followed set
 *  drives the `scope=following` activity feed in GET /v1/artifacts. Author/path follows
 *  are scoped to the caller's active workspace; people (`user`) follows are global
 *  (org_id = "*"). All endpoints require a signed-in user.
 *
 *  Contract-first: the Follow response schema below is the SINGLE source for the web
 *  client's `Follow` type (generated from the OpenAPI spec into apps/web/src/api-types.ts).
 *  A change to the shape here changes the spec, fails the openapi snapshot, regenerates
 *  the web type, and breaks any stale web code at `tsc` — never silently in production. */
export const followRoutes = (ctx: AppContext) => {
  const { meta, requireUser, activeWorkspace } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  // Author targets are normalized to lowercase so they match the (lowercased)
  // author_login comparison in followedArtifactIds; path targets are kept verbatim.
  const normalizeTarget = (kind: FollowKind, target: string): string =>
    kind === "author" ? target.trim().toLowerCase() : target.trim()

  const kind = z.enum(["author", "path", "user"])
  const followBody = z.object({
    kind,
    target: z.string().min(1, "target is required"),
  })

  // A follow as it goes OUT to clients: the stored record, plus — for people-follows —
  // the resolved public handle/name/avatar (the raw user id never leaves the server;
  // `target` carries the handle instead). Named ("Follow") so it surfaces as a reusable
  // component schema the web client imports by name.
  const Follow = z
    .object({
      id: z.string(),
      org_id: z.string(),
      user_id: z.string(),
      kind,
      target: z.string(),
      created_at: z.string(),
      handle: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
      image: z.string().nullable().optional(),
    })
    .openapi("Follow")

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

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/follows",
      tags: ["Follows"],
      summary: "List the signed-in user's follows in their active workspace.",
      responses: {
        200: {
          description:
            "The caller's follows. People-follows carry the followed person's public handle/name/avatar.",
          content: { "application/json": { schema: z.object({ follows: z.array(Follow) }) } },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
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
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/follows",
      tags: ["Follows"],
      summary: "Follow a GitHub author, a repo path prefix, or a person.",
      responses: {
        201: {
          description: "The created follow.",
          content: { "application/json": { schema: z.object({ follow: Follow }) } },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const b = await readJson(c, followBody)
      if (b instanceof Response) return bail(b)
      const r = await resolve(c, me, b)
      if (r instanceof Response) return bail(r)
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
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/follows",
      tags: ["Follows"],
      summary: "Remove a follow (idempotent).",
      responses: { 204: { description: "The follow was removed." } },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const b = await readJson(c, followBody)
      if (b instanceof Response) return bail(b)
      const r = await resolve(c, me, b)
      if (r instanceof Response) return bail(r)
      await meta.removeFollow(me.id, r.orgId, b.kind, r.target)
      return c.body(null, 204)
    },
  )

  return app
}
