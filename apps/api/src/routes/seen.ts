import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { bail, fail, readJson } from "../lib/http"

/** A reader's last-seen position in an activity stream: `ws:<org_id>` for the workspace
 *  feed, `artifact:<short_id>` for an artifact's rail. Private to the signed-in user — the
 *  row is theirs alone, so the only checks are shape and size. The web draws its "New"
 *  marker from the value it reads at the start of a visit, advances it on visible dwell,
 *  and rewinds it only on an explicit "mark new from here" (`manual`). */
const SCOPE = /^(ws|artifact):[A-Za-z0-9_-]{1,64}$/
const Scope = z.string().regex(SCOPE, "scope is ws:<id> or artifact:<id>")
const SeenAt = z.object({ seen_at: z.string().nullable() })

export const seenRoutes = (ctx: AppContext) => {
  const { meta, requireUser } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/seen",
      tags: ["Activity"],
      summary: "Where the signed-in user last left an activity stream.",
      request: { query: z.object({ scope: Scope }) },
      responses: {
        200: {
          description: "The last-seen time, or null before the first visit.",
          content: { "application/json": { schema: SeenAt } },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const { scope } = c.req.valid("query")
      return c.json({ seen_at: await meta.getActivitySeen(me.id, scope) })
    },
  )

  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/seen",
      tags: ["Activity"],
      summary: "Move the signed-in user's position in an activity stream.",
      responses: {
        200: {
          description:
            "What is stored after the write: forward-only unless `manual`, so a slow write never rewinds a fresher one.",
          content: { "application/json": { schema: SeenAt } },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const body = await readJson(
        c,
        z.object({ scope: Scope, at: z.string().datetime(), manual: z.boolean().optional() }),
      )
      if (body instanceof Response) return bail(body)
      if (Date.parse(body.at) > Date.now() + 60_000)
        return bail(fail(c, 400, "at cannot be in the future."))
      const seen_at = await meta.setActivitySeen(me.id, body.scope, body.at, {
        manual: body.manual,
      })
      return c.json({ seen_at })
    },
  )

  return app
}
