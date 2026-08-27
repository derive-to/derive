import { type FollowKind, GLOBAL_FOLLOW_ORG, newId, normalizeUsername } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { bail, fail, readJson } from "../lib/http"

/** People follows drive the `scope=following` activity feed in GET /v1/artifacts.
 *  They are global (org_id = "*"). All endpoints require a signed-in user.
 *
 *  Contract-first: the Follow response schema below is the SINGLE source for the web
 *  client's `Follow` type (generated from the OpenAPI spec into apps/web/src/api-types.ts).
 *  A change to the shape here changes the spec, fails the openapi snapshot, regenerates
 *  the web type, and breaks any stale web code at `tsc` — never silently in production. */
export const followRoutes = (ctx: AppContext) => {
  const { meta, requireUser, activeWorkspace } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  const kind = z.literal("user")
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
      org_id: z
        .string()
        .describe('The workspace this follow is scoped to; "*" (global) for people-follows'),
      user_id: z.string().describe("The follower (the signed-in user who owns this follow)"),
      kind: kind.describe("What's followed: a person"),
      target: z.string().describe("The followed person's public @handle"),
      created_at: z.string(),
      handle: z
        .string()
        .nullable()
        .optional()
        .describe("For people-follows, the followed person's public @handle; absent otherwise"),
      name: z
        .string()
        .nullable()
        .optional()
        .describe("For people-follows, the followed person's display name; absent otherwise"),
      image: z
        .string()
        .nullable()
        .optional()
        .describe("For people-follows, the followed person's avatar URL; absent otherwise"),
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
    const profile = await meta.getUserByUsername(normalizeUsername(b.target))
    if (!profile) return fail(c, 404, "no profile with that username")
    if (profile.id === me.id) return fail(c, 400, "you can't follow yourself")
    if ((await meta.sharedOrgIds(me.id, profile.id)).length === 0)
      return fail(c, 403, "you can only follow people you share a workspace with")
    return { target: profile.id, orgId: GLOBAL_FOLLOW_ORG, followedUserId: profile.id }
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
      // batched lookup. The internal id is replaced by the handle in `target` on the way out.
      const userIds = follows.map((f) => f.target)
      const byId = new Map(
        userIds.length ? (await meta.getUsers(userIds)).map((u) => [u.id, u] as const) : [],
      )
      return c.json({
        follows: follows.map((f) => {
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
      summary: "Follow a person.",
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
          actor: me.name ?? me.username ?? "Someone",
          kind: "follow",
          artifact_id: "",
          artifact_short_id: "",
          artifact_title: null,
          thread_id: "",
          comment_id: "",
          // The follower's handle, for the bell's profile link (the row's text is the bell's
          // own). `actor` is the display name, like every other notification's.
          preview: me.username ?? "",
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
