import { newId } from "@derive/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { SIGNUP_SOURCE_ARTIFACT, SIGNUP_SOURCE_KIND } from "../lib/attribution"
import { buildBetaEmail } from "../lib/email"
import { fail, readJson } from "../lib/http"
import { looksLikeEmail } from "../lib/invite"
import { enqueueChannelDelivery } from "../webhooks"

/**
 * Beta signups — the marketing site's request-access form. Public and anonymous
 * by design (it's the front door), so the surface is deliberately small: record
 * the email, send the access email through the retrying outbox, and reveal
 * nothing about whether the address was already on the list (signing up again
 * doubles as "resend my link"). Abuse is bounded by the authEmail IP cap and the
 * anonymous-write allow-list entry, both in app.ts.
 */
export const betaRoutes = (ctx: AppContext) => {
  const { meta, deps } = ctx
  const app = new Hono()

  // authz-exempt: public beta signup (the marketing form) — anonymous by design, bounded by the authEmail IP cap, idempotent per email.
  app.post("/v1/beta/signup", async (c) => {
    const b = await readJson(
      c,
      z.object({
        email: z.string().max(254),
        source_kind: z.string().regex(SIGNUP_SOURCE_KIND).optional(),
        source_artifact: z.string().regex(SIGNUP_SOURCE_ARTIFACT).optional(),
        landing_path: z
          .string()
          .max(200)
          .refine((path) => path.startsWith("/") && !path.startsWith("//"))
          .optional(),
      }),
    )
    if (b instanceof Response) return b
    const email = b.email.trim().toLowerCase()
    if (!looksLikeEmail(email)) return fail(c, 400, "a valid email is required")

    const fresh = await meta.recordBetaSignup(newId("beta"), email)
    const access = new URL("/login", deps.baseUrl)
    access.searchParams.set("signup", "1")
    if (b.source_kind) access.searchParams.set("src", b.source_kind.toLowerCase())
    if (b.source_artifact) access.searchParams.set("art", b.source_artifact)
    if (b.landing_path) access.searchParams.set("landing", b.landing_path)
    await enqueueChannelDelivery(
      meta,
      "email",
      fresh ? "beta.signup" : "beta.resend",
      buildBetaEmail({ to: email, url: access.toString() }),
    )
    deps.pokeWebhooks?.()
    return c.json({ ok: true }, 202)
  })

  return app
}
