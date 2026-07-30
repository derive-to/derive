# The billing rail: Stripe on Team and Business

**Date:** 2026-07-30 · **Status:** approved · **Driver:** GTM plan step 11 ("Build the billing rail"): Stripe products for Team $15 / Business $30 per editor, monthly + annual, read-only lapse behavior, beta grace window. Done when a test workspace subscribes end to end.

## Problem

The paid boundary exists but no money can cross it. The pricing page (`apps/web/public/site/pricing.html`) publishes the contract: Free is 3 editor seats and 1 GB storage (`:214`), Team is $15 per editor monthly / $12 annual with 50 GB (`:217-231`), Business is $30 / $25 with 250 GB (`:232-247`), lapse means read-only with nothing deleted (`:275-277`, `:300-303`), and billing starts only with notice ("we'll announce dates well ahead", `:312-315`). White-label is already gated on `OrgSettings.whiteLabel` (`packages/core/src/ports.ts:2392`) with the GTM note "step 11 maps Stripe onto this boolean." But there is no Stripe integration, no subscription state, no seat sync, and the storage cap is one global `DERIVE_MAX_BYTES` (`apps/api/src/config.ts:190`) applied identically to every workspace by `overStorage` (`apps/api/src/context.ts:700-703`). Nothing distinguishes a paying workspace from a free one.

## The model (decided 2026-07-30)

- Free while a workspace has at most 3 editor seats AND under 1 GB stored. A billable seat is a workspace membership with role `editor` or `owner` (`packages/db/src/schema.ts:241-251`); viewers, commenters, and agents are never seats.
- Crossing either boundary is a user-initiated upgrade to Team, never an auto-charge. A 4th editor seat, or 1 GB of storage at any seat count, is the trigger. Once subscribed, every editor seat is billable, including the first three: 4 editors on Team is $60/month minimum, and a storage-triggered upgrade at 1 to 3 seats is the only route to $15/$30/$45 subscriptions.
- Seat counting is licensed-on-grant: Stripe quantity = current billable seats, synced when seats change. (The pricing FAQ's activity-based sentence at `pricing.html:297-299` needs a copy tweak before enforcement day; flagged below, not part of this build.)
- Beta grace: until an operator sets `DERIVE_BILLING_ENFORCE_AT` (unset today), nothing is blocked and no one is forced to upgrade, but subscribing works end to end. This honors the published promise.

## Change

### 1. Subscription state: one table, webhook-fed, Stripe is the source of truth

New `subscription` table keyed by `org_id` in both dialect schemas (`packages/db/src/schema.ts`, `packages/db/src/pg-schema.ts`), classified in `parity.ts`, applied additively on boot per the existing DDL flow, `deploy/d1-schema.sql` regenerated. Columns: `org_id` (PK), `stripe_customer_id`, `stripe_subscription_id`, `tier` (`team|business`), `billing_interval` (`month|year`), `status` (Stripe's status string, verbatim), `quantity`, `current_period_end`, `created_at`, `updated_at`. Named `tier`, not plan: `PlanRecord` is already taken by BYO model credentials (`apps/api/src/routes/plans.ts`).

`MetaStore` gains `getSubscription(orgId)`, `getSubscriptionByStripeId(subscriptionId)`, and `upsertSubscription(record)`, implemented in all three adapters (`repos.ts`, `pg.ts`, D1 path) and covered by `packages/db/test/store-contract.ts`. No metering table: seat count is computed live from `listMemberships` (`packages/core/src/ports.ts:566`), filtered to editor+owner.

### 2. The pure gate: `packages/core/src/billing.ts`

One pure function next to `permissions.ts`, unit-tested in core with no DB:

`resolveBillingState({ subscription, seatCount, now, enforceAt, fallbackMaxBytes })` returns `{ tier, subscriptionActive, canPublishApprove, blockedReason?, storageCapBytes, whiteLabelEntitled }`. The gate never inspects stored bytes itself: it produces the cap, and the existing `overStorage` comparison enforces it on incoming writes.

Rules:
- An active subscription (`status` in `active|trialing|past_due`; `past_due` stays writable while Stripe retries dunning) ⇒ full access, storage cap 50 GB (Team) or 250 GB (Business), white-label entitled. This holds during beta too: a workspace that subscribes early gets its tier cap immediately.
- Otherwise, `enforceAt` unset or in the future ⇒ `canPublishApprove: true`, storage cap falls back to `fallbackMaxBytes` (today's `DERIVE_MAX_BYTES` behavior), `whiteLabelEntitled: true` (free during beta, matching the shipped toggle copy).
- After `enforceAt`, no active subscription: `seatCount <= 3` keeps publish/approve with a 1 GB cap; `seatCount > 3` ⇒ `canPublishApprove: false`, `blockedReason: "needs_team"`. A formerly-subscribed org whose status is `canceled|unpaid|incomplete_expired` ⇒ `blockedReason: "lapsed"`. White-label not entitled either way.
- The gate reads only local state (subscription row + membership count); no Stripe call ever happens on the request path.
- Read and comment are never touched by any of this; nothing is ever deleted; no link goes dark.

### 3. Enforcement at the existing choke points

A `billingGate(orgId)` helper in `context.ts` next to `overStorage` loads the subscription row plus seat count and applies `resolveBillingState`. Called where the quota checks already live, returning the same failure shapes the surfaces already use (HTTP 402 `billing_required` / `billing_lapsed`; MCP `err(...)` text):

- REST publish: create + revise in `routes/artifacts.ts` (beside the storage checks at `:584/:594`)
- Proposal publish path: `routes/proposals.ts` (beside `:222/:234`)
- MCP: `mcp-tools/publish.ts` (beside `:417-421`), `mcp-tools/checkpoint.ts` (beside `:134-136`), hosted session turns (`lib/session-turn.ts:245` path)
- Approvals: `approveProposalAction` callers (`routes/proposals.ts:387`, `lib/slack-proposal.ts:87`) and review approve (`routes/review.ts:80-108`)

`overStorage` (`context.ts:700`) becomes plan-aware: the cap comes from `resolveBillingState().storageCapBytes` instead of raw `deps.maxBytes`. Self-host (no Stripe config) keeps exactly today's behavior: `DERIVE_MAX_BYTES` or nothing.

White-label mapping: the derived `badge` boolean on the workspace/artifact detail (`routes/workspace.ts:658` and wherever it feeds the viewer) computes from `OrgSettings.whiteLabel && whiteLabelEntitled`. The settings toggle itself stays writable; it simply has no effect without entitlement, and the Billing section says so.

### 4. Stripe integration: `routes/billing.ts` + a driver in deps

Official `stripe` npm SDK with `Stripe.createFetchHttpClient()` (Workers-compatible; webhook verification via `constructEventAsync` on webcrypto). A `BillingDriver` interface on `createApp` deps (the `makeAuthedApp` test harness injects a fake), constructed from `STRIPE_SECRET_KEY` when present; absent keys disable the routes with a clear 503, and self-host never notices.

Routes (owner-gated via `requireWorkspace(c, "manage")` except the webhook):
- `GET /v1/billing` — tier, status, interval, quantity, live seat count, `current_period_end`, storage used/cap, `enforce_at`, beta flag. Recomputes seats and heals Stripe-quantity drift as a side effect.
- `POST /v1/billing/checkout` — body `{ tier: team|business, interval: month|year }`. 409 when a subscription is already active (plan switches happen in the Portal). Creates/reuses the Stripe customer (id stored on the subscription row), then a Checkout Session: `mode: subscription`, price resolved by lookup key, `quantity` = current billable seats, `subscription_data.metadata.org_id` + `client_reference_id` = org id, success/cancel URLs on `/settings/billing`. Returns `{ url }`.
- `POST /v1/billing/portal` — Customer Portal session for card, plan switches, cancellation, invoices. Returns `{ url }`.
- `POST /v1/billing/webhook` — plain-Hono, no auth, signature-verified with `STRIPE_WEBHOOK_SECRET`, path added to `ANON_WRITE_ALLOW` (`app.ts:345-360`), mirroring the Slack webhook pattern (`routes/slack.ts:256`, `lib/slack.ts:13`). Handles `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.payment_failed`; each handler is an idempotent upsert of the local row resolved by `metadata.org_id` first, `stripe_subscription_id` second.

Prices are four licensed per-seat recurring prices under two products, resolved at runtime by lookup key so no price IDs live in env: `team_monthly` $15, `team_annual` $144/yr, `business_monthly` $30, `business_annual` $300/yr. `apps/api/scripts/stripe-seed.mjs` creates products/prices idempotently (looks up by lookup key before creating) against whatever key is in `STRIPE_SECRET_KEY`.

### 5. Seat sync

`syncSeats(orgId)` recomputes billable seats and, when a subscription row exists and the count changed, updates the Stripe subscription item quantity with proration. Called after every membership write: add/change member (`routes/workspace.ts:298/:353`), remove (`:388`), invite accept (`:577`), and lazy `ensureMembership` joins (`context.ts:707`) when the default role is editor. `GET /v1/billing`'s drift-heal is the backstop, so a missed hook is corrected the next time anyone looks at the billing page. Failures are logged and never block the membership change itself.

### 6. Config

Three additions to `config.ts` + `config-manifest.ts` under a new `billing` group: `STRIPE_SECRET_KEY` (secret), `STRIPE_WEBHOOK_SECRET` (secret), `DERIVE_BILLING_ENFORCE_AT` (ISO 8601 instant; unset = beta grace, everything free). Cloudflare: `wrangler secret put` for the two secrets, var for the date. Documented in `.env.example` and `DEPLOY.md`'s env table.

### 7. Web: a Billing section in Settings

New `apps/web/src/pages/settings/billing-section.tsx` registered in the Workspace group (`pages/settings/index.tsx:29-42/:77-84/:136-152`), owner-gated like `general-section.tsx`. Shows: current plan card (Free/Team/Business + status + renewal date), live seat count with the free-tier boundary ("3 of 3 free editor seats used"), storage used against the cap, a monthly/annual toggle, Upgrade to Team / Business buttons that POST checkout and redirect to Stripe, and Manage billing (Portal) once subscribed. During beta it carries the grace note ("Free while we're in beta; billing starts only with notice"). When the workspace is blocked (`needs_team`/`lapsed`), publish surfaces already return the 402 code and the web publish error paths link here. API client methods in `apps/web/src/api.ts`; `openapi.json` + generated `api-types.ts` regenerated.

### 8. Tests

- Core: `resolveBillingState` table tests (beta grace, 3-seat boundary, storage boundary, past_due vs canceled, white-label entitlement, self-host fallback).
- API route tests (`apps/api/test/billing.test.ts`, `makeAuthedApp` + fake driver): non-owner 403s, checkout returns URL + correct quantity, bad webhook signature 400, good webhook upserts the row, subscription lifecycle transitions, seat sync fires on member add/role change/remove, publish/approve 402 when enforced + over-boundary, publish untouched during beta, storage cap switches with tier.
- Contract: new store methods across sqlite/pg/d1 in `store-contract.ts`.
- E2E (the done criterion): with real test-mode keys, run the seed script, subscribe a test workspace through hosted Checkout with the 4242 card, webhook delivered via `stripe listen`, confirm `GET /v1/billing` reports Team active and the settings page shows it.

## Out of scope

Founding-member annual (GTM step 12), storage overage line items ("~$1 per extra 10 GB"), billing per-artifact guest editor shares (`artifactMember` editor grants are unbilled in v1; a follow-up before enforcement), dunning emails beyond Stripe's own, an in-app invoice list (the Portal covers it), Enterprise contracts, and any pricing-page copy changes.

## Flags for launch day (not this build)

1. Pricing FAQ copy: "anyone who publishes or approves work during a billing period" (`pricing.html:297-299`) describes activity-based counting; licensed-on-grant needs it to say "anyone holding an editor seat." Owner: Connor, before `DERIVE_BILLING_ENFORCE_AT` is set.
2. Guest editor shares are free in v1 (above); decide whether they count as seats before enforcement.
3. Enforcement day runbook: set the env date, verify the announcement went out first.
