import { can, newId } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import { getCookie, setCookie } from "hono/cookie"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { bail, fail, readJson, VIEW_DEDUP_MS } from "../lib/http"

/** View recording (de-duped, owner self-views excluded) + per-artifact stats. The
 *  Analytics response schema is the single source for the web client's type. */
export const analyticsRoutes = (ctx: AppContext) => {
  const { meta, deps, analyticsOn, currentUser, actorFor, requireArtifact, authorize } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  const Analytics = z
    .object({
      total: z.number(),
      unique: z.number(),
      anonViewers: z.number(),
      perVersion: z.array(z.object({ version: z.number(), count: z.number() })),
      daily: z.array(z.object({ day: z.string(), count: z.number() })),
      recent: z.array(
        z.object({
          viewer: z.string(),
          kind: z.enum(["user", "anon"]),
          at: z.string(),
          avatar: z.string().nullable().optional(),
        }),
      ),
    })
    .openapi("Analytics")

  // Record a view. The viewer is the logged-in user, or a stable anonymous id
  // kept in a cookie (so unique-viewer counts work for public/link artifacts).
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/view",
      tags: ["Analytics"],
      summary: "Record a view of an artifact (de-duped; owner self-views excluded).",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        204: { description: "Recorded (or skipped as a dup / self-view / disabled)." },
      },
    }),
    async (c) => {
      if (!analyticsOn) return c.body(null, 204)
      const artifact = await meta.getByShortId(c.req.param("shortId"))
      if (!artifact || artifact.current_version === 0 || !(await authorize(c, "read", artifact)))
        return bail(fail(c, 404, "not found"))
      // The owner's own opens aren't audience — don't count them (Notion/Docs do
      // the same). `manage` requires the owner role, so this is exactly "is owner";
      // editors/commenters/viewers and anonymous openers still count.
      const actor = await actorFor(c, artifact)
      if (actor.kind !== "anon" && can(actor, "manage", artifact.visibility))
        return c.body(null, 204)
      const me = await currentUser(c)
      let viewer: string
      let kind: "user" | "anon"
      if (me) {
        // Stable identity = the account. The same signed-in person is one viewer,
        // shown by name — never "anonymous".
        viewer = me.id
        kind = "user"
      } else {
        // A long-lived first-party cookie keeps the same browser as one anonymous
        // viewer across opens. SameSite=None;Secure when the SPA is cross-site, so
        // it actually sticks there (Lax would be dropped on the cross-site fetch).
        let vid = getCookie(c, "derive_vid")
        if (!vid) {
          vid = newId("anon")
          setCookie(c, "derive_vid", vid, {
            path: "/",
            maxAge: 60 * 60 * 24 * 365,
            httpOnly: true,
            sameSite: deps.crossSite ? "None" : "Lax",
            secure: deps.crossSite || new URL(deps.baseUrl).protocol === "https:",
          })
        }
        viewer = vid
        kind = "anon"
      }
      const body = await readJson(c, z.object({ version: z.number().int().optional() }))
      if (body instanceof Response) return bail(body)
      const version = body.version ?? artifact.current_version
      // De-dup: skip if this viewer already saw this version recently (a refresh).
      const since = new Date(Date.now() - VIEW_DEDUP_MS).toISOString()
      if (await meta.viewedSince(artifact.id, viewer, version, since)) return c.body(null, 204)
      await meta.recordView({
        id: newId("v"),
        artifact_id: artifact.id,
        version,
        viewer,
        viewer_kind: kind,
      })
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/artifacts/{shortId}/analytics",
      tags: ["Analytics"],
      summary: "View stats for an artifact (collaborators only).",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        200: {
          description: "Totals, per-version + daily counts, and recent distinct viewers.",
          content: { "application/json": { schema: Analytics } },
        },
      },
    }),
    async (c) => {
      if (!analyticsOn) return bail(fail(c, 404, "analytics disabled"))
      const artifact = await requireArtifact(c, "read")
      if (artifact instanceof Response) return bail(artifact)
      // Who-viewed-this is for COLLABORATORS, not every signed-in reader. `read`
      // access is satisfied by any signed-in user on a public/link artifact, so the
      // not-anon check alone would expose the view counts + viewer identities to a
      // cross-workspace stranger. Require a workspace member / sharee (or token),
      // exactly like the member-roster gate. See bug-hunt B-020 (and B-013).
      const actor = await actorFor(c, artifact)
      const collaborator =
        actor.kind === "token" ||
        (actor.kind === "user" && (actor.orgRole != null || actor.artifactRole != null))
      if (!collaborator) return bail(fail(c, 404, "not found"))
      const stats = await meta.viewStats(artifact.id)
      // Recent user-viewers are stored by id (stable); resolve to a public handle
      // (or display name) + avatar — never the email (off the wire, like the rosters).
      const userIds = stats.recent.filter((r) => r.kind === "user").map((r) => r.viewer)
      if (userIds.length) {
        const byId = new Map((await meta.getUsers(userIds)).map((u) => [u.id, u]))
        stats.recent = stats.recent.map((r) => {
          if (r.kind !== "user") return r
          const u = byId.get(r.viewer)
          return { ...r, viewer: u?.name ?? u?.username ?? "Someone", avatar: u?.image ?? null }
        })
      }
      return c.json(stats)
    },
  )

  return app
}
