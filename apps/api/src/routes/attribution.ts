import { newId } from "@derive/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { isSignupAttributionWindow, signupAttribution } from "../lib/attribution"
import { fail, readJson } from "../lib/http"

export const attributionRoutes = (ctx: AppContext) => {
  const app = new Hono()

  app.post("/v1/me/signup-attribution", async (c) => {
    const me = await ctx.requireUser(c)
    if (me instanceof Response) return me
    const body = await readJson(
      c,
      z.object({
        source_kind: z.string().max(40),
        source_artifact: z.string().max(12).nullable().optional(),
        landing_path: z.string().max(200).nullable().optional(),
      }),
    )
    if (body instanceof Response) return body
    const attribution = signupAttribution(me.id, newId("src"), body)
    if (!attribution) return fail(c, 400, "invalid signup source")

    // A deliberately neutral no-op: this is optional measurement, not a capability
    // or an oracle about account age. The unique store index also keeps first-write.
    if (!isSignupAttributionWindow(me.createdAt)) return c.json({ ok: true })
    try {
      await ctx.meta.recordSignupAttribution(attribution)
    } catch {
      // Measurement never gets to break an account that was already created.
    }
    return c.json({ ok: true })
  })

  return app
}
