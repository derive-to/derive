import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { lookupKeyFor, recordFromSnapshot } from "../lib/billing"
import { fail, readJson } from "../lib/http"
import { billableSeatCount, syncSeats } from "../lib/seats"
import { log } from "../log"

/**
 * The Stripe billing rail: the workspace's billing truth (GET), start a
 * checkout for a new plan, hand off to the Stripe portal for an existing one,
 * and the webhook that keeps the local subscription row in sync. Plain-Hono
 * (no OpenAPI contract — this is a fast-moving internal surface, not the
 * documented public API). The webhook is the one anonymous route here
 * (ANON_WRITE_ALLOW entry in app.ts); the Stripe signature is its gate, same
 * pattern as the Slack webhooks in routes/slack.ts.
 */
export const billingRoutes = (ctx: AppContext) => {
  const app = new Hono()
  const {
    meta,
    deps,
    billingState,
    requireWorkspace,
    currentUser,
    workspaceRole,
    activeWorkspace,
    blockCopy,
  } = ctx
  const billing = deps.billing

  // The workspace's billing truth, any member (same split as GET /v1/workspace/settings:
  // read is for everyone, the PATCH-equivalents here — checkout, portal — stay
  // "manage" only). Also heals Stripe seat drift as a side effect: a membership
  // write's own syncSeats call can be lost (a dropped response, a swallowed Stripe
  // hiccup), so the next look here re-checks and pushes the correction — reusing the
  // subscription + seat count already fetched below (`pre`) instead of syncSeats
  // re-querying them — before reading state, so the response reflects reality
  // regardless of who's reading.
  app.get("/v1/billing", async (c) => {
    const role = await workspaceRole(c)
    if (role === null) return fail(c, 401, "unauthenticated")
    const org = await activeWorkspace(c)
    const [sub, seats, stored, assets] = await Promise.all([
      meta.getSubscription(org),
      billableSeatCount(meta, org),
      meta.storageBytes(org),
      meta.assetStorageBytes(org),
    ])
    const healed = await syncSeats({ meta, billing }, org, { sub, seats })
    const subOut = healed ?? sub
    const state = await billingState(org, { sub: subOut, seatCount: seats })
    const beta = state.betaGrace
    return c.json({
      tier: state.tier,
      status: subOut?.status ?? null,
      interval: subOut?.billing_interval ?? null,
      quantity: subOut?.quantity ?? null,
      seats,
      current_period_end: subOut?.current_period_end ?? null,
      storage: { used_bytes: stored + assets, cap_bytes: state.storageCapBytes ?? null },
      enforce_at: deps.billingEnforceAt ?? null,
      beta,
      subscribed: state.subscriptionActive,
      blocked: state.blockedReason ? blockCopy[state.blockedReason] : null,
    })
  })

  app.post("/v1/billing/checkout", async (c) => {
    const org = await requireWorkspace(c, "manage")
    if (org instanceof Response) return org
    if (!billing) return fail(c, 503, "Billing is not configured on this deployment.")
    const b = await readJson(
      c,
      z.object({ tier: z.enum(["team", "business"]), interval: z.enum(["month", "year"]) }),
    )
    if (b instanceof Response) return b
    const state = await billingState(org)
    if (state.betaGrace) return fail(c, 409, "Billing is not enabled on this instance.")
    if (state.subscriptionActive)
      return fail(
        c,
        409,
        "This workspace already has an active plan. Manage it from the billing portal.",
      )
    const existing = await meta.getSubscription(org)
    const me = await currentUser(c)
    const customerId = await billing.ensureCustomer({
      orgId: org,
      email: me?.email ?? null,
      existingId: existing?.stripe_customer_id ?? null,
    })
    const seats = Math.max(1, await billableSeatCount(meta, org))
    // Stub row: remembers the customer id across an abandoned checkout. Grants
    // nothing (status "incomplete", no subscription id) until the webhook lands.
    // tier/interval here are placeholders to satisfy the row shape — the webhook
    // overwrites them with Stripe's truth once the subscription actually exists.
    const nowIso = new Date().toISOString()
    await meta.upsertSubscription({
      org_id: org,
      stripe_customer_id: customerId,
      stripe_subscription_id: existing?.stripe_subscription_id ?? null,
      tier: b.tier,
      billing_interval: b.interval,
      status: existing?.status ?? "incomplete",
      quantity: seats,
      current_period_end: existing?.current_period_end ?? null,
      created_at: existing?.created_at ?? nowIso,
      updated_at: nowIso,
    })
    const { url } = await billing.createCheckoutSession({
      customerId,
      priceLookupKey: lookupKeyFor(b.tier, b.interval),
      quantity: seats,
      orgId: org,
      successUrl: `${deps.baseUrl}/settings/billing?checkout=success`,
      cancelUrl: `${deps.baseUrl}/settings/billing`,
    })
    return c.json({ url })
  })

  app.post("/v1/billing/portal", async (c) => {
    const org = await requireWorkspace(c, "manage")
    if (org instanceof Response) return org
    if (!billing) return fail(c, 503, "Billing is not configured on this deployment.")
    const sub = await meta.getSubscription(org)
    if (!sub) return fail(c, 409, "No billing on this workspace yet. Start with an upgrade.")
    const { url } = await billing.createPortalSession({
      customerId: sub.stripe_customer_id,
      returnUrl: `${deps.baseUrl}/settings/billing`,
    })
    return c.json({ url })
  })

  // Stripe webhook. No auth: the signature is the gate (ANON_WRITE_ALLOW entry
  // in app.ts), same pattern as the Slack/GitHub webhooks.
  // authz-exempt: Stripe signs every request (stripe-signature header, verified below); no session on a webhook.
  app.post("/v1/billing/webhook", async (c) => {
    if (!billing) return fail(c, 503, "Billing is not configured on this deployment.")
    const sig = c.req.header("stripe-signature")
    if (!sig) return fail(c, 400, "missing stripe-signature")
    const payload = await c.req.text()
    let event: Awaited<ReturnType<typeof billing.verifyWebhook>>
    try {
      event = await billing.verifyWebhook(payload, sig)
    } catch (err) {
      log.warn("billing webhook: bad signature", {
        error: err instanceof Error ? err.message : String(err),
      })
      return fail(c, 400, "bad signature")
    }
    if (event.type === "checkout.session.completed" && event.subscriptionId) {
      const snap = await billing.getSubscription(event.subscriptionId)
      if (snap?.orgId) {
        const existing = await meta.getSubscription(snap.orgId)
        await meta.upsertSubscription(recordFromSnapshot(snap.orgId, snap, existing))
      }
    } else if (event.type.startsWith("customer.subscription.") && event.snapshot) {
      // Delivery order isn't guaranteed — Stripe can retry an older event after a
      // newer one already landed (e.g. a stale "active" `updated` retried after the
      // `deleted` that followed it in real time). Trusting the payload verbatim would
      // let that stale retry flip a canceled row back to active forever, since no
      // further events arrive to correct it. So the payload only tells us WHICH
      // subscription changed; refetch it by id and upsert from that authoritative
      // snapshot instead, the same defense checkout.session.completed already uses.
      // Stripe keeps canceled subscriptions retrievable (getSubscription only returns
      // null for a genuinely missing id), so this covers `deleted` events too. Any
      // other failure (auth, network, rate limit) rethrows out of the driver, which
      // correctly 500s the webhook so Stripe retries instead of us acking bad data.
      const snap = await billing.getSubscription(event.snapshot.id)
      if (snap) {
        const orgId = snap.orgId ?? (await meta.getSubscriptionByStripeId(snap.id))?.org_id ?? null
        if (orgId) {
          const existing = await meta.getSubscription(orgId)
          await meta.upsertSubscription(recordFromSnapshot(orgId, snap, existing))
        }
      }
    }
    // invoice.payment_failed and anything else: acknowledged; subscription.updated
    // carries the status change that matters.
    return c.json({ received: true })
  })

  return app
}
