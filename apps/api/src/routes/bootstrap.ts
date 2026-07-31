import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import {
  Collection,
  collectionsJson,
  Notification,
  OrgSettings,
  summaryJson,
} from "../lib/boot-shapes"
import { bail, fail } from "../lib/http"

/** The signed-in app shell's first breath as ONE request. On a cold boot the SPA used
 *  to fan out four authenticated GETs (tags summary, collections, workspace settings,
 *  notifications) — each paying its own Worker invocation, its own auth resolution and
 *  its own Postgres round trips on its own pg.Client. This answers all four from one
 *  MetaStore.bootstrap call (one fat statement on the hosted tier), each field the
 *  EXACT body its standalone endpoint returns — the shapes and mappers are shared
 *  (lib/boot-shapes), so the batched and individual paths cannot drift, and the client
 *  seeds the individual query caches from this response verbatim.
 *
 *  Deliberately NOT here: /v1/me/onboarding (its OAuth-grant read is optional-schema,
 *  guarded by try/catch in the store — an arm that can throw must not poison the
 *  batch), /v1/workspaces (token/grant-bound branches carry different semantics), and
 *  the library list itself (it must start first and finish first, uncoupled from the
 *  slowest sidebar arm). Member-only: the client falls back to the individual
 *  endpoints (which each have their own non-member shape) on any failure. */
export const bootstrapRoutes = (ctx: AppContext) => {
  const { meta, currentUser, activeWorkspace, isMember } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  const NOTIFICATIONS_PAGE = 50 // same page size the notifications route serves

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/bootstrap",
      tags: ["Session"],
      summary: "The signed-in boot payload: sidebar summary, collections, settings, notifications.",
      responses: {
        200: {
          description:
            "Everything the app shell fetches on boot, in one round trip. Each field is exactly the corresponding endpoint's body (tags / collections / workspace settings / notifications).",
          content: {
            "application/json": {
              schema: z.object({
                summary: z.object({
                  total: z.number(),
                  favorites: z.number(),
                  mine: z.number(),
                  mine_private: z.number(),
                  tags: z.array(z.object({ tag: z.string(), count: z.number() })),
                  workspace: z.string().nullable(),
                }),
                collections: z.array(Collection),
                settings: OrgSettings,
                notifications: z.array(Notification),
                unread: z.number(),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const me = await currentUser(c)
      if (!me) return bail(fail(c, 401, "unauthenticated"))
      const org = await activeWorkspace(c)
      // Member-only by design: each individual endpoint has its own non-member shape
      // (empty summary, empty collections, …) and the client already knows them — a
      // 403 here sends it down that path rather than teaching this route four more.
      if (!(await isMember(c, org))) return bail(fail(c, 403, "forbidden"))
      const b = await meta.bootstrap(org, me.id, NOTIFICATIONS_PAGE)
      return c.json({
        summary: summaryJson(b.summary),
        // Browser sessions only reach here (agents boot no app shell), so the
        // operator-token owner-everywhere branch is a plain `false`.
        collections: collectionsJson(b.collections, b.sources, b.collectionRoles, me.id, false),
        settings: b.settings,
        notifications: b.notifications.notifications,
        unread: b.notifications.unread,
      })
    },
  )

  return app
}
