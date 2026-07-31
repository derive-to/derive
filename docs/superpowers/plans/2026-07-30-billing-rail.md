# Billing Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stripe billing for Team ($15/editor/mo, $144/yr) and Business ($30/mo, $300/yr): checkout, webhook-fed subscription state, seat sync, read-only lapse enforcement, plan-aware storage caps, and a Billing settings section.

**Architecture:** A pure `resolveBillingState` gate in `packages/core` reads a webhook-fed `subscription` row plus a live seat count; the API enforces it at the existing publish/approve/quota choke points. Stripe is reached only through a `BillingDriver` injected on `AppDeps` (official `stripe` SDK with the fetch client in production, a fake in tests). Hosted Checkout and the Customer Portal do all payment UI.

**Tech Stack:** Hono + @hono/zod-openapi, Drizzle (sqlite/d1 + pg), Better Auth (untouched), `stripe` npm SDK, Vitest, React + TanStack Router/Query.

**Spec:** `docs/superpowers/specs/2026-07-30-billing-rail-design.md`

## Global Constraints

- Worktree: `/Users/connor/Downloads/Claude/Derive/derive/.claude/worktrees/billing-rail`, branch `feat/billing-rail`. All commands run there. Use `corepack pnpm`, never bare npm/pnpm.
- No em dashes in any user-facing copy (UI strings, error messages, doc prose). Commas, colons, periods.
- Every error response goes through `fail(c, status, message, extra?)` (`apps/api/src/lib/http.ts:14`); machine-readable context rides `extra`. Body parsing through `readJson`. `bail()` wraps early returns inside `app.openapi` handlers only.
- Both dialects always: any schema change lands in `packages/db/src/schema.ts` AND `packages/db/src/pg-schema.ts`, is classified in `packages/db/src/parity.ts`, and regenerates the D1 schema via `corepack pnpm --filter @derive/db gen:d1-schema`.
- New columns/tables must be additive (nullable or constant default) so boot-time DDL self-applies.
- Precommit runs the full `pnpm ci` lint suite automatically; never `--no-verify`. If `lint:deadcode` (knip) flags an export a LATER task consumes, squash that task's commit into the consumer's rather than suppressing.
- Billable seat = membership row with role `editor` or `owner`. Roles: `viewer|commenter|editor|owner` (`packages/core/src/roles.ts:15`); "Admin" in copy means `owner`.
- Test money numbers: Team $15/mo = 1500 cents, $144/yr = 14400; Business $30/mo = 3000, $300/yr = 30000. Lookup keys: `team_monthly`, `team_annual`, `business_monthly`, `business_annual`.
- Free boundaries: `FREE_SEAT_LIMIT = 3`, caps `free: 1 GiB`, `team: 50 GiB`, `business: 250 GiB` (binary GiB: `1024 ** 3`).
- Stripe test keys: NOT needed until Task 9. Everything before runs against the fake driver.

---

### Task 1: The pure gate in core

**Files:**
- Create: `packages/core/src/billing.ts`
- Modify: `packages/core/src/ports.ts` (add `SubscriptionRecord` near `SignupAttributionRecord`, ~line 1820)
- Modify: `packages/core/src/index.ts` (add `export * from "./billing"` beside the existing star exports)
- Test: `packages/core/test/billing.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (later tasks import all of these from `@derive/core`):
  - `interface SubscriptionRecord { org_id: string; stripe_customer_id: string; stripe_subscription_id: string | null; tier: "team" | "business"; billing_interval: "month" | "year"; status: string; quantity: number; current_period_end: string | null; created_at: string; updated_at: string }`
  - `type BillingTier = "free" | "team" | "business"`
  - `interface BillingState { tier: BillingTier; subscriptionActive: boolean; canPublishApprove: boolean; blockedReason?: "needs_team" | "lapsed"; storageCapBytes?: number; whiteLabelEntitled: boolean }`
  - `resolveBillingState(args: { subscription: SubscriptionRecord | null; seatCount: number; now: Date; enforceAt?: Date | null; fallbackMaxBytes?: number }): BillingState`
  - `const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due"]`
  - `const LAPSED_SUBSCRIPTION_STATUSES = ["canceled", "unpaid", "incomplete_expired"]`
  - `const FREE_SEAT_LIMIT = 3`
  - `const STORAGE_CAPS: Record<"free" | "team" | "business", number>`

- [ ] **Step 1: Write the failing test**

`packages/core/test/billing.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import {
  FREE_SEAT_LIMIT,
  resolveBillingState,
  STORAGE_CAPS,
  type SubscriptionRecord,
} from "../src"

const NOW = new Date("2026-07-30T12:00:00Z")
const PAST = new Date("2026-01-01T00:00:00Z")
const FUTURE = new Date("2027-01-01T00:00:00Z")

const sub = (over: Partial<SubscriptionRecord> = {}): SubscriptionRecord => ({
  org_id: "default",
  stripe_customer_id: "cus_1",
  stripe_subscription_id: "sub_1",
  tier: "team",
  billing_interval: "month",
  status: "active",
  quantity: 4,
  current_period_end: "2026-08-30T12:00:00Z",
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
  ...over,
})

describe("resolveBillingState", () => {
  it("beta (no enforceAt): everything allowed, fallback cap, white-label entitled", () => {
    const s = resolveBillingState({
      subscription: null,
      seatCount: 10,
      now: NOW,
      enforceAt: null,
      fallbackMaxBytes: 123,
    })
    expect(s).toEqual({
      tier: "free",
      subscriptionActive: false,
      canPublishApprove: true,
      storageCapBytes: 123,
      whiteLabelEntitled: true,
    })
  })

  it("beta with no fallback cap: storage unlimited (self-host)", () => {
    const s = resolveBillingState({ subscription: null, seatCount: 1, now: NOW })
    expect(s.storageCapBytes).toBeUndefined()
    expect(s.canPublishApprove).toBe(true)
  })

  it("an active subscription always wins, beta or enforced, and gets its tier cap", () => {
    for (const enforceAt of [null, PAST, FUTURE]) {
      const s = resolveBillingState({
        subscription: sub(),
        seatCount: 4,
        now: NOW,
        enforceAt,
        fallbackMaxBytes: 123,
      })
      expect(s.tier).toBe("team")
      expect(s.subscriptionActive).toBe(true)
      expect(s.canPublishApprove).toBe(true)
      expect(s.storageCapBytes).toBe(STORAGE_CAPS.team)
      expect(s.whiteLabelEntitled).toBe(true)
    }
  })

  it("business tier gets the business cap", () => {
    const s = resolveBillingState({
      subscription: sub({ tier: "business" }),
      seatCount: 2,
      now: NOW,
      enforceAt: PAST,
    })
    expect(s.storageCapBytes).toBe(STORAGE_CAPS.business)
  })

  it("past_due stays writable (dunning); canceled does not", () => {
    const dunning = resolveBillingState({
      subscription: sub({ status: "past_due" }),
      seatCount: 4,
      now: NOW,
      enforceAt: PAST,
    })
    expect(dunning.canPublishApprove).toBe(true)
    const lapsed = resolveBillingState({
      subscription: sub({ status: "canceled" }),
      seatCount: 4,
      now: NOW,
      enforceAt: PAST,
    })
    expect(lapsed.canPublishApprove).toBe(false)
    expect(lapsed.blockedReason).toBe("lapsed")
    expect(lapsed.whiteLabelEntitled).toBe(false)
  })

  it("enforced, no sub, within free seats: allowed at the free cap, no white-label", () => {
    const s = resolveBillingState({
      subscription: null,
      seatCount: FREE_SEAT_LIMIT,
      now: NOW,
      enforceAt: PAST,
      fallbackMaxBytes: 999,
    })
    expect(s.canPublishApprove).toBe(true)
    expect(s.storageCapBytes).toBe(STORAGE_CAPS.free)
    expect(s.whiteLabelEntitled).toBe(false)
  })

  it("enforced, no sub, 4th seat: blocked with needs_team", () => {
    const s = resolveBillingState({
      subscription: null,
      seatCount: FREE_SEAT_LIMIT + 1,
      now: NOW,
      enforceAt: PAST,
    })
    expect(s.canPublishApprove).toBe(false)
    expect(s.blockedReason).toBe("needs_team")
  })

  it("an incomplete (never-paid) sub row counts as no subscription, not lapsed", () => {
    const s = resolveBillingState({
      subscription: sub({ status: "incomplete", stripe_subscription_id: null }),
      seatCount: 2,
      now: NOW,
      enforceAt: PAST,
    })
    expect(s.canPublishApprove).toBe(true)
    expect(s.blockedReason).toBeUndefined()
  })

  it("enforceAt in the future is still beta", () => {
    const s = resolveBillingState({
      subscription: null,
      seatCount: 10,
      now: NOW,
      enforceAt: FUTURE,
    })
    expect(s.canPublishApprove).toBe(true)
    expect(s.whiteLabelEntitled).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `corepack pnpm --filter @derive/core exec vitest run test/billing.test.ts`
Expected: FAIL, `resolveBillingState` is not exported.

- [ ] **Step 3: Implement**

Add to `packages/core/src/ports.ts`, directly after `SignupAttributionRecord` (~line 1830), matching neighboring doc-comment style:

```ts
/** One workspace's Stripe subscription state, webhook-fed; Stripe is the source
 *  of truth and this row is the local cache the request-path gate reads. A row
 *  with a null stripe_subscription_id and status "incomplete" is a checkout
 *  stub (customer created, nothing paid yet) and grants nothing. */
export interface SubscriptionRecord {
  org_id: string
  stripe_customer_id: string
  stripe_subscription_id: string | null
  tier: "team" | "business"
  billing_interval: "month" | "year"
  /** Stripe's subscription status, verbatim (active, trialing, past_due, canceled, ...). */
  status: string
  quantity: number
  current_period_end: string | null
  created_at: string
  updated_at: string
}
```

Create `packages/core/src/billing.ts`:

```ts
import type { SubscriptionRecord } from "./ports"

export type BillingTier = "free" | "team" | "business"

/** Statuses that grant full access. past_due stays writable while Stripe
 *  retries the card (dunning); the workspace only locks once Stripe gives up. */
export const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due"] as const

/** A formerly-live subscription that ended. Distinct from "incomplete" (a
 *  checkout that never paid), which counts as no subscription at all. */
export const LAPSED_SUBSCRIPTION_STATUSES = ["canceled", "unpaid", "incomplete_expired"] as const

export const FREE_SEAT_LIMIT = 3

const GIB = 1024 ** 3
export const STORAGE_CAPS = {
  free: 1 * GIB,
  team: 50 * GIB,
  business: 250 * GIB,
} as const

export interface BillingState {
  tier: BillingTier
  subscriptionActive: boolean
  canPublishApprove: boolean
  blockedReason?: "needs_team" | "lapsed"
  /** undefined = unlimited (self-host with no DERIVE_MAX_BYTES). */
  storageCapBytes?: number
  whiteLabelEntitled: boolean
}

/**
 * The one billing decision, pure and DB-free. Rules, in order:
 *  1. An active subscription wins outright (beta or not) and carries its tier cap.
 *  2. Before enforcement (enforceAt unset or future): the published beta promise,
 *     nothing blocked, storage stays on the operator's fallback cap.
 *  3. After enforcement: a lapsed subscription is read-only; a free workspace
 *     over FREE_SEAT_LIMIT is read-only until an owner upgrades; within the
 *     limit it keeps publishing at the free cap. Read/comment are never touched
 *     here; callers gate only publish/approve.
 */
export const resolveBillingState = (args: {
  subscription: SubscriptionRecord | null
  seatCount: number
  now: Date
  enforceAt?: Date | null
  fallbackMaxBytes?: number
}): BillingState => {
  const { subscription: sub, seatCount, now, enforceAt, fallbackMaxBytes } = args
  if (sub && (ACTIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(sub.status)) {
    return {
      tier: sub.tier,
      subscriptionActive: true,
      canPublishApprove: true,
      storageCapBytes: STORAGE_CAPS[sub.tier],
      whiteLabelEntitled: true,
    }
  }
  const enforced = !!enforceAt && enforceAt.getTime() <= now.getTime()
  if (!enforced) {
    return {
      tier: "free",
      subscriptionActive: false,
      canPublishApprove: true,
      storageCapBytes: fallbackMaxBytes,
      whiteLabelEntitled: true,
    }
  }
  const base = {
    tier: "free" as const,
    subscriptionActive: false,
    storageCapBytes: STORAGE_CAPS.free,
    whiteLabelEntitled: false,
  }
  if (sub && (LAPSED_SUBSCRIPTION_STATUSES as readonly string[]).includes(sub.status))
    return { ...base, canPublishApprove: false, blockedReason: "lapsed" }
  if (seatCount > FREE_SEAT_LIMIT)
    return { ...base, canPublishApprove: false, blockedReason: "needs_team" }
  return { ...base, canPublishApprove: true }
}
```

Add to `packages/core/src/index.ts` beside the other star exports: `export * from "./billing"`. (If `ports` is star-exported there already, `SubscriptionRecord` rides along; verify with `grep -n "export \*" packages/core/src/index.ts`.)

- [ ] **Step 4: Run tests**

Run: `corepack pnpm --filter @derive/core exec vitest run test/billing.test.ts`
Expected: PASS (9 tests). Then the whole core suite: `corepack pnpm --filter @derive/core test` stays green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/billing.ts packages/core/src/ports.ts packages/core/src/index.ts packages/core/test/billing.test.ts
git commit -m "feat(core): resolveBillingState, the pure billing gate"
```

---

### Task 2: The subscription table and store methods

**Files:**
- Modify: `packages/db/src/schema.ts` (table after `orgSettings`, ~line 656)
- Modify: `packages/db/src/pg-schema.ts` (after `orgSettings`, ~line 538)
- Modify: `packages/db/src/parity.ts` (import `SubscriptionRecord`, add `subscription: SubscriptionRecord` to `TypedTables`)
- Modify: `packages/core/src/ports.ts` (three `MetaStore` methods near `getOrgSettings`)
- Modify: `packages/db/src/repos.ts` (sqlite/d1 impl near `getOrgSettings`, ~line 1864)
- Modify: `packages/db/src/pg.ts` (pg impl near `getOrgSettings`, ~line 1664)
- Modify: `packages/db/test/store-contract.ts` (new describe block near the orgSettings one)
- Regenerate: `deploy/d1-schema.sql` via `corepack pnpm --filter @derive/db gen:d1-schema`

**Interfaces:**
- Consumes: `SubscriptionRecord` from Task 1.
- Produces on `MetaStore` (all three adapters):
  - `getSubscription(orgId: string): Promise<SubscriptionRecord | null>`
  - `getSubscriptionByStripeId(stripeSubscriptionId: string): Promise<SubscriptionRecord | null>`
  - `upsertSubscription(s: SubscriptionRecord): Promise<void>`

- [ ] **Step 1: Write the failing contract test**

In `packages/db/test/store-contract.ts`, after the org-settings block, inside the same suite function:

```ts
it("subscription: absent → null; upsert inserts then updates; stripe-id lookup", async () => {
  const org = `sub_org_${suffix}`
  expect(await store.getSubscription(org)).toBeNull()
  expect(await store.getSubscriptionByStripeId("sub_nope")).toBeNull()
  const now = new Date().toISOString()
  await store.upsertSubscription({
    org_id: org,
    stripe_customer_id: "cus_1",
    stripe_subscription_id: `sub_stripe_${suffix}`,
    tier: "team",
    billing_interval: "month",
    status: "active",
    quantity: 4,
    current_period_end: "2026-08-30T00:00:00.000Z",
    created_at: now,
    updated_at: now,
  })
  const row = await store.getSubscription(org)
  expect(row?.tier).toBe("team")
  expect(row?.quantity).toBe(4)
  expect((await store.getSubscriptionByStripeId(`sub_stripe_${suffix}`))?.org_id).toBe(org)
  // Second upsert for the same org exercises the onConflict update path.
  await store.upsertSubscription({
    ...(row as SubscriptionRecord),
    status: "canceled",
    quantity: 5,
    updated_at: new Date().toISOString(),
  })
  const updated = await store.getSubscription(org)
  expect(updated?.status).toBe("canceled")
  expect(updated?.quantity).toBe(5)
})
```

Mirror the surrounding block's idioms exactly (how `suffix`/org ids are built there, existing imports; add `SubscriptionRecord` to the `@derive/core` type import).

- [ ] **Step 2: Run to verify it fails**

Run: `corepack pnpm --filter @derive/db test`
Expected: FAIL, `getSubscription is not a function` (plus a TypeScript error until the port lands).

- [ ] **Step 3: Implement schema + port + both adapters**

`packages/db/src/schema.ts`, after `orgSettings`:

```ts
// One workspace's Stripe subscription cache (webhook-fed; Stripe is the source
// of truth). A row with a null stripe_subscription_id is a checkout stub.
export const subscription = sqliteTable("subscription", {
  org_id: text("org_id").primaryKey(),
  stripe_customer_id: text("stripe_customer_id").notNull(),
  stripe_subscription_id: text("stripe_subscription_id"),
  tier: text("tier").$type<"team" | "business">().notNull(),
  billing_interval: text("billing_interval").$type<"month" | "year">().notNull(),
  status: text("status").notNull(),
  quantity: integer("quantity").notNull(),
  current_period_end: text("current_period_end"),
  created_at: text("created_at").notNull().default(now),
  updated_at: text("updated_at").notNull(),
})
```

`packages/db/src/pg-schema.ts`, after `orgSettings` (pg dialect: `pgTable`, `$defaultFn(isoNow)` for created_at, `integer` from the pg column imports — copy the neighbors):

```ts
export const subscription = pgTable("subscription", {
  org_id: text("org_id").primaryKey(),
  stripe_customer_id: text("stripe_customer_id").notNull(),
  stripe_subscription_id: text("stripe_subscription_id"),
  tier: text("tier").$type<"team" | "business">().notNull(),
  billing_interval: text("billing_interval").$type<"month" | "year">().notNull(),
  status: text("status").notNull(),
  quantity: integer("quantity").notNull(),
  current_period_end: text("current_period_end"),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
  updated_at: text("updated_at").notNull(),
})
```

`packages/db/src/parity.ts`: add `SubscriptionRecord` to the `@derive/core` import list and `subscription: SubscriptionRecord` to `TypedTables` (alphabetical position with its neighbors).

`packages/core/src/ports.ts`, next to `getOrgSettings`/`setOrgSettings` in `MetaStore`:

```ts
  /** The workspace's cached Stripe subscription, absent ⇒ null (free). */
  getSubscription(orgId: string): Promise<SubscriptionRecord | null>
  /** Webhook resolution fallback when metadata.org_id is missing. */
  getSubscriptionByStripeId(stripeSubscriptionId: string): Promise<SubscriptionRecord | null>
  upsertSubscription(s: SubscriptionRecord): Promise<void>
```

`packages/db/src/repos.ts`, beside `getOrgSettings` (factory-const style):

```ts
  const getSubscription = async (orgId: string): Promise<SubscriptionRecord | null> =>
    (await db.select().from(subscription).where(eq(subscription.org_id, orgId)).get()) ?? null
  const getSubscriptionByStripeId = async (sid: string): Promise<SubscriptionRecord | null> =>
    (await db
      .select()
      .from(subscription)
      .where(eq(subscription.stripe_subscription_id, sid))
      .get()) ?? null
  const upsertSubscription = async (s: SubscriptionRecord): Promise<void> => {
    const { org_id: _org, created_at: _created, ...set } = s
    await db
      .insert(subscription)
      .values(s)
      .onConflictDoUpdate({ target: subscription.org_id, set })
  }
```

Register all three in the returned store object (wherever `getOrgSettings` is listed). `packages/db/src/pg.ts`, class-method style:

```ts
  async getSubscription(orgId: string): Promise<SubscriptionRecord | null> {
    const rows = await this.db.select().from(subscription).where(eq(subscription.org_id, orgId))
    return rows[0] ?? null
  }
  async getSubscriptionByStripeId(sid: string): Promise<SubscriptionRecord | null> {
    const rows = await this.db
      .select()
      .from(subscription)
      .where(eq(subscription.stripe_subscription_id, sid))
    return rows[0] ?? null
  }
  async upsertSubscription(s: SubscriptionRecord): Promise<void> {
    const { org_id: _org, created_at: _created, ...set } = s
    await this.db
      .insert(subscription)
      .values(s)
      .onConflictDoUpdate({ target: subscription.org_id, set })
  }
```

Import `subscription` (and `SubscriptionRecord`) in both adapter files, matching existing import blocks.

- [ ] **Step 4: Regenerate the D1 schema and run db tests**

Run: `corepack pnpm --filter @derive/db gen:d1-schema && corepack pnpm --filter @derive/db test`
Expected: PASS, and `deploy/d1-schema.sql` gains a `CREATE TABLE ... subscription` statement (check with `git diff --stat deploy/`; if the file lives elsewhere the gen output names it).

- [ ] **Step 5: Commit**

```bash
git add packages/db packages/core/src/ports.ts deploy/
git commit -m "feat(db): subscription table + store methods, all dialects"
```

---

### Task 3: Config, the BillingDriver, and the Stripe/fake drivers

**Files:**
- Modify: `apps/api/src/config.ts` (three `Config` fields + `loadConfig` reads)
- Modify: `apps/api/src/config-manifest.ts` (new `billing` group + three entries)
- Modify: `.env.example` (three commented entries, following its format)
- Create: `apps/api/src/lib/billing.ts` (driver interface + Stripe impl + record mapping)
- Create: `apps/api/test/fake-billing.ts` (fake driver)
- Modify: `apps/api/src/context.ts` (`AppDeps` gains `billing?: BillingDriver` and `billingEnforceAt?: string`; no behavior yet)
- Modify: `apps/api/src/node.ts` + `apps/api/src/worker.ts` (wire config → deps, following exactly how `maxBytes` flows in each)
- Modify: `apps/api/package.json` (dependency `stripe`)
- Test: `apps/api/test/billing-driver.test.ts`
- Regenerate: `corepack pnpm --filter @derive/api gen:env` (config-manifest snapshot)

**Interfaces:**
- Consumes: `SubscriptionRecord` (Task 1).
- Produces:
  - `interface BillingDriver { ensureCustomer(a: { orgId: string; email: string | null; existingId: string | null }): Promise<string>; createCheckoutSession(a: { customerId: string; priceLookupKey: string; quantity: number; orgId: string; successUrl: string; cancelUrl: string }): Promise<{ url: string }>; createPortalSession(a: { customerId: string; returnUrl: string }): Promise<{ url: string }>; setQuantity(subscriptionId: string, quantity: number): Promise<void>; getSubscription(subscriptionId: string): Promise<SubscriptionSnapshot | null>; verifyWebhook(payload: string, signature: string): Promise<BillingEvent> }`
  - `interface SubscriptionSnapshot { id: string; customerId: string; status: string; priceLookupKey: string; quantity: number; currentPeriodEnd: string | null; orgId: string | null }`
  - `type BillingEvent = { type: string; subscriptionId?: string; snapshot?: SubscriptionSnapshot }` (the driver reduces raw Stripe events to this; the route never touches Stripe types)
  - `stripeBillingDriver(a: { secretKey: string; webhookSecret?: string }): BillingDriver`
  - `recordFromSnapshot(orgId: string, snap: SubscriptionSnapshot, existing: SubscriptionRecord | null): SubscriptionRecord` (maps `priceLookupKey` "team_monthly" etc. to `tier`/`billing_interval`)
  - Test-side: `class FakeBilling implements BillingDriver` with call-recording arrays (`checkouts`, `quantityCalls`) and settable `nextEvent`; `verifyWebhook` throws unless `signature === "test-sig"`, then returns `JSON.parse(payload)`.

- [ ] **Step 1: Install the SDK**

Run: `corepack pnpm --filter @derive/api add stripe`
Expected: `stripe` lands in `apps/api/package.json` dependencies.

- [ ] **Step 2: Write the failing driver test**

`apps/api/test/billing-driver.test.ts` (pure unit, no network):

```ts
import type { SubscriptionRecord } from "@derive/core"
import { describe, expect, it } from "vitest"
import { recordFromSnapshot } from "../src/lib/billing"

const snap = {
  id: "sub_1",
  customerId: "cus_1",
  status: "active",
  priceLookupKey: "business_annual",
  quantity: 3,
  currentPeriodEnd: "2027-07-30T00:00:00.000Z",
  orgId: "default",
}

describe("recordFromSnapshot", () => {
  it("maps lookup key to tier + interval and carries quantities", () => {
    const r = recordFromSnapshot("default", snap, null)
    expect(r.tier).toBe("business")
    expect(r.billing_interval).toBe("year")
    expect(r.status).toBe("active")
    expect(r.quantity).toBe(3)
    expect(r.stripe_subscription_id).toBe("sub_1")
  })
  it("keeps created_at from an existing row and refreshes updated_at", () => {
    const existing: SubscriptionRecord = recordFromSnapshot("default", snap, null)
    const bumped = recordFromSnapshot("default", { ...snap, status: "canceled" }, existing)
    expect(bumped.created_at).toBe(existing.created_at)
    expect(bumped.status).toBe("canceled")
  })
  it("falls back to team/month on an unknown lookup key", () => {
    const r = recordFromSnapshot("default", { ...snap, priceLookupKey: "custom" }, null)
    expect(r.tier).toBe("team")
    expect(r.billing_interval).toBe("month")
  })
})
```

Run: `corepack pnpm --filter @derive/api exec vitest run test/billing-driver.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `apps/api/src/lib/billing.ts`**

```ts
import type { SubscriptionRecord } from "@derive/core"
import Stripe from "stripe"

/** What the webhook/route layer needs from a Stripe subscription, provider-shaped
 *  types kept out of the routes entirely. */
export interface SubscriptionSnapshot {
  id: string
  customerId: string
  status: string
  priceLookupKey: string
  quantity: number
  currentPeriodEnd: string | null
  orgId: string | null
}

/** A verified webhook, reduced: the route switches on `type` and upserts from
 *  `snapshot`; anything the rail doesn't model simply has no snapshot. */
export type BillingEvent = {
  type: string
  subscriptionId?: string
  snapshot?: SubscriptionSnapshot
}

export interface BillingDriver {
  ensureCustomer(a: { orgId: string; email: string | null; existingId: string | null }): Promise<string>
  createCheckoutSession(a: {
    customerId: string
    priceLookupKey: string
    quantity: number
    orgId: string
    successUrl: string
    cancelUrl: string
  }): Promise<{ url: string }>
  createPortalSession(a: { customerId: string; returnUrl: string }): Promise<{ url: string }>
  setQuantity(subscriptionId: string, quantity: number): Promise<void>
  getSubscription(subscriptionId: string): Promise<SubscriptionSnapshot | null>
  verifyWebhook(payload: string, signature: string): Promise<BillingEvent>
}

const TIERS: Record<string, { tier: "team" | "business"; interval: "month" | "year" }> = {
  team_monthly: { tier: "team", interval: "month" },
  team_annual: { tier: "team", interval: "year" },
  business_monthly: { tier: "business", interval: "month" },
  business_annual: { tier: "business", interval: "year" },
}

/** Snapshot → local row. Unknown lookup keys (a price edited by hand in the
 *  dashboard) fall back to team/month rather than failing the webhook: status,
 *  not tier, is what gates access. */
export const recordFromSnapshot = (
  orgId: string,
  snap: SubscriptionSnapshot,
  existing: SubscriptionRecord | null,
): SubscriptionRecord => {
  const t = TIERS[snap.priceLookupKey] ?? { tier: "team" as const, interval: "month" as const }
  const now = new Date().toISOString()
  return {
    org_id: orgId,
    stripe_customer_id: snap.customerId,
    stripe_subscription_id: snap.id,
    tier: t.tier,
    billing_interval: t.interval,
    status: snap.status,
    quantity: snap.quantity,
    current_period_end: snap.currentPeriodEnd,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  }
}

const toSnapshot = (sub: Stripe.Subscription): SubscriptionSnapshot => {
  const item = sub.items.data[0]
  return {
    id: sub.id,
    customerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    status: sub.status,
    priceLookupKey: item?.price.lookup_key ?? "",
    quantity: item?.quantity ?? 1,
    currentPeriodEnd: sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : null,
    orgId: sub.metadata?.org_id ?? null,
  }
}

/** The real driver. Fetch HTTP client + SubtleCrypto so the same code runs on
 *  Workers and Node. Price ids are resolved from lookup keys once and cached
 *  for the process lifetime (the seed script owns the keys). */
export const stripeBillingDriver = (a: { secretKey: string; webhookSecret?: string }): BillingDriver => {
  const stripe = new Stripe(a.secretKey, { httpClient: Stripe.createFetchHttpClient() })
  const cryptoProvider = Stripe.createSubtleCryptoProvider()
  const priceIds = new Map<string, string>()
  const priceId = async (lookupKey: string): Promise<string> => {
    const hit = priceIds.get(lookupKey)
    if (hit) return hit
    const found = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 })
    const id = found.data[0]?.id
    if (!id) throw new Error(`no Stripe price with lookup key ${lookupKey}; run scripts/stripe-seed.mjs`)
    priceIds.set(lookupKey, id)
    return id
  }
  return {
    ensureCustomer: async ({ orgId, email, existingId }) => {
      if (existingId) return existingId
      const c = await stripe.customers.create({
        email: email ?? undefined,
        metadata: { org_id: orgId },
      })
      return c.id
    },
    createCheckoutSession: async ({ customerId, priceLookupKey, quantity, orgId, successUrl, cancelUrl }) => {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        client_reference_id: orgId,
        line_items: [{ price: await priceId(priceLookupKey), quantity }],
        subscription_data: { metadata: { org_id: orgId } },
        success_url: successUrl,
        cancel_url: cancelUrl,
      })
      if (!session.url) throw new Error("Stripe returned a checkout session with no url")
      return { url: session.url }
    },
    createPortalSession: async ({ customerId, returnUrl }) => {
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      })
      return { url: session.url }
    },
    setQuantity: async (subscriptionId, quantity) => {
      const sub = await stripe.subscriptions.retrieve(subscriptionId)
      const item = sub.items.data[0]
      if (!item) return
      await stripe.subscriptions.update(subscriptionId, {
        items: [{ id: item.id, quantity }],
        proration_behavior: "create_prorations",
      })
    },
    getSubscription: async (subscriptionId) => {
      try {
        return toSnapshot(await stripe.subscriptions.retrieve(subscriptionId))
      } catch {
        return null
      }
    },
    verifyWebhook: async (payload, signature) => {
      if (!a.webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured")
      const event = await stripe.webhooks.constructEventAsync(
        payload,
        signature,
        a.webhookSecret,
        undefined,
        cryptoProvider,
      )
      const type = event.type
      if (type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session
        const sid = typeof session.subscription === "string" ? session.subscription : session.subscription?.id
        return { type, subscriptionId: sid }
      }
      if (type.startsWith("customer.subscription.")) {
        return { type, snapshot: toSnapshot(event.data.object as Stripe.Subscription) }
      }
      return { type }
    },
  }
}
```

(Adjust `Stripe.Subscription.current_period_end` access if the installed SDK major moved it, e.g. newer API versions expose it per item; `corepack pnpm --filter @derive/api exec tsc --noEmit` is the referee. Keep the mapping inside `toSnapshot` either way.)

- [ ] **Step 4: The fake driver**

`apps/api/test/fake-billing.ts`:

```ts
import type { BillingDriver, BillingEvent, SubscriptionSnapshot } from "../src/lib/billing"

/** In-memory Stripe stand-in. Signature "test-sig" is the only valid one; the
 *  payload IS the BillingEvent as JSON, so tests author events directly. */
export class FakeBilling implements BillingDriver {
  checkouts: Array<{ priceLookupKey: string; quantity: number; orgId: string }> = []
  quantityCalls: Array<{ subscriptionId: string; quantity: number }> = []
  subscriptions = new Map<string, SubscriptionSnapshot>()
  customersCreated = 0

  async ensureCustomer(a: { orgId: string; email: string | null; existingId: string | null }) {
    if (a.existingId) return a.existingId
    this.customersCreated += 1
    return `cus_fake_${a.orgId}`
  }
  async createCheckoutSession(a: {
    customerId: string
    priceLookupKey: string
    quantity: number
    orgId: string
    successUrl: string
    cancelUrl: string
  }) {
    this.checkouts.push({ priceLookupKey: a.priceLookupKey, quantity: a.quantity, orgId: a.orgId })
    return { url: `https://checkout.stripe.test/${a.orgId}` }
  }
  async createPortalSession() {
    return { url: "https://portal.stripe.test/session" }
  }
  async setQuantity(subscriptionId: string, quantity: number) {
    this.quantityCalls.push({ subscriptionId, quantity })
  }
  async getSubscription(subscriptionId: string) {
    return this.subscriptions.get(subscriptionId) ?? null
  }
  async verifyWebhook(payload: string, signature: string): Promise<BillingEvent> {
    if (signature !== "test-sig") throw new Error("bad signature")
    return JSON.parse(payload) as BillingEvent
  }
}
```

- [ ] **Step 5: Config + deps + wiring**

`apps/api/src/config.ts`: add to `Config` (beside `maxBytes`):

```ts
  stripeSecretKey?: string
  stripeWebhookSecret?: string
  /** ISO instant after which the free-tier boundaries enforce. Unset = beta grace. */
  billingEnforceAt?: string
```

and in `loadConfig` beside the maxBytes lines:

```ts
    stripeSecretKey: env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
    billingEnforceAt: env.DERIVE_BILLING_ENFORCE_AT,
```

`apps/api/src/config-manifest.ts`: add `{ id: "billing", title: "Billing (Stripe)" }` to the groups list and three entries in manifest style:

```ts
  // -- billing --
  {
    name: "STRIPE_SECRET_KEY",
    group: "billing",
    doc: "Stripe secret key (sk_test_/sk_live_). Unset disables the billing routes\nentirely; self-host never needs it.",
    example: "",
  },
  {
    name: "STRIPE_WEBHOOK_SECRET",
    group: "billing",
    doc: "Signing secret for the Stripe webhook endpoint (whsec_...). Required for\n/v1/billing/webhook to accept events.",
    example: "",
  },
  {
    name: "DERIVE_BILLING_ENFORCE_AT",
    group: "billing",
    doc: "ISO instant after which free-tier boundaries enforce (3 editor seats, 1 GB).\nUnset = beta grace: nothing is blocked and white-label stays free.",
    example: "2026-09-01T00:00:00Z",
  },
```

`apps/api/src/context.ts` `AppDeps`: beside `maxBytes?: number` add

```ts
  /** Stripe access, injected so tests fake it and self-host omits it. */
  billing?: BillingDriver
  /** ISO instant when free-tier boundaries enforce; unset = beta grace. */
  billingEnforceAt?: string
```

with `import type { BillingDriver } from "./lib/billing"`.

`apps/api/src/node.ts` and `apps/api/src/worker.ts`: find where `maxBytes` flows from config/env into `createApp`'s deps and add, in the same spot:

```ts
    billing: cfg.stripeSecretKey
      ? stripeBillingDriver({ secretKey: cfg.stripeSecretKey, webhookSecret: cfg.stripeWebhookSecret })
      : undefined,
    billingEnforceAt: cfg.billingEnforceAt,
```

(in worker.ts the equivalents read from its env/bindings object; mirror how it maps the other config values, e.g. `env.STRIPE_SECRET_KEY`).

`.env.example`: three commented lines in the file's established format, same doc one-liners as the manifest.

- [ ] **Step 6: Regenerate manifest snapshot, typecheck, run tests**

Run: `corepack pnpm --filter @derive/api gen:env && corepack pnpm --filter @derive/api exec vitest run test/billing-driver.test.ts test/config-manifest.test.ts`
Expected: PASS. Also `corepack pnpm --filter @derive/api exec tsc --noEmit` clean (catches SDK type drift in the driver).

- [ ] **Step 7: Commit**

```bash
git add apps/api packages/db .env.example pnpm-lock.yaml
git commit -m "feat(api): BillingDriver port, Stripe driver, billing config"
```

---

### Task 4: Enforcement at the choke points + plan-aware storage

**Files:**
- Modify: `apps/api/src/context.ts` (`billingState`, `billingBlocked`, plan-aware `overStorage`; export both on the context object beside `overStorage`)
- Modify: `apps/api/src/routes/artifacts.ts` (create/revise publish path, beside the org resolution at ~line 537)
- Modify: `apps/api/src/routes/proposals.ts` (approve handler, after the `authorize(c, "approve", ...)` at ~line 380)
- Modify: `apps/api/src/routes/review.ts` (approve handler, after `requireArtifact(c, "approve", ...)` at ~line 96)
- Modify: `apps/api/src/lib/slack-proposal.ts` (before `approveProposalAction` at ~line 87)
- Modify: `apps/api/src/mcp-tools/publish.ts` (beside the `ctx.overStorage` check at ~line 420)
- Modify: `apps/api/src/mcp-tools/checkpoint.ts` (beside the `ctx.overStorage` check at ~line 136)
- Modify: `apps/api/src/lib/session-turn.ts` (before the publish at ~line 235)
- Test: `apps/api/test/billing-gate.test.ts`

**Interfaces:**
- Consumes: Task 1 gate, Task 2 store methods, Task 3 deps.
- Produces on ctx (later tasks call these):
  - `billingState(orgId: string): Promise<BillingState>`
  - `billingBlocked(orgId: string): Promise<"needs_team" | "lapsed" | null>`
  - Error contract: HTTP surfaces reply `fail(c, 402, message, { code })` with code `billing_required` (needs_team) or `billing_lapsed`; MCP surfaces return `err(message)`.
  - Copy (no em dashes): needs_team → `"This workspace has more than 3 editor seats, which needs the Team plan. An owner can upgrade in Settings, Billing."`; lapsed → `"This workspace's plan has lapsed, so publishing is paused. Nothing was deleted. An owner can renew in Settings, Billing."`

- [ ] **Step 1: Write the failing tests**

`apps/api/test/billing-gate.test.ts`. Use the harness idioms from `apps/api/test/workspace.test.ts` and helpers (`makeAuthedApp`, `as`, `publishAs`). Four users so the default workspace has 4 editor seats (users[0] owner + 3 editors). `PAST` enforce date turns enforcement on; omit it for the beta case.

```ts
import { describe, expect, it } from "vitest"
import { FakeBilling } from "./fake-billing"
import { as, makeAuthedApp, publishAs, type TestUser } from "./helpers"

const u = (n: number): TestUser => ({ id: `u${n}`, email: `u${n}@x.test`, name: `U${n}` })
const FOUR = [u(1), u(2), u(3), u(4)]
const THREE = [u(1), u(2), u(3)]
const PAST = "2000-01-01T00:00:00Z"

const seedSub = async (store: Awaited<ReturnType<typeof makeAuthedApp>>["meta"], status: string) => {
  const now = new Date().toISOString()
  await store.upsertSubscription({
    org_id: "default",
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_1",
    tier: "team",
    billing_interval: "month",
    status,
    quantity: 4,
    current_period_end: null,
    created_at: now,
    updated_at: now,
  })
}

describe("billing gate", () => {
  it("beta: 4 editor seats publish freely", async () => {
    const { app } = makeAuthedApp("bg_beta", FOUR, "editor", {
      deps: { billing: new FakeBilling() },
    })
    const r = await publishAs(app, "u2@x.test", "hello")
    expect(r.status).toBe(201)
  })

  it("enforced + 4 seats + no sub: publish 402 billing_required", async () => {
    const { app } = makeAuthedApp("bg_needs", FOUR, "editor", {
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    const r = await publishAs(app, "u2@x.test", "hello")
    expect(r.status).toBe(402)
    expect((await r.json()).code).toBe("billing_required")
  })

  it("enforced + 3 seats: publish stays open", async () => {
    const { app } = makeAuthedApp("bg_three", THREE, "editor", {
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    expect((await publishAs(app, "u2@x.test", "hello")).status).toBe(201)
  })

  it("enforced + active sub: 4 seats publish", async () => {
    const { app, meta } = makeAuthedApp("bg_active", FOUR, "editor", {
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    await seedSub(meta, "active")
    expect((await publishAs(app, "u2@x.test", "hello")).status).toBe(201)
  })

  it("enforced + canceled sub: read-only lapse, even at 3 seats", async () => {
    const { app, meta } = makeAuthedApp("bg_lapsed", THREE, "editor", {
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    await seedSub(meta, "canceled")
    const r = await publishAs(app, "u2@x.test", "hello")
    expect(r.status).toBe(402)
    expect((await r.json()).code).toBe("billing_lapsed")
  })

  it("lapse blocks review approve too, but reading stays open", async () => {
    const { app, meta } = makeAuthedApp("bg_lapse_read", THREE, "editor", {
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    const pub = await publishAs(app, "u2@x.test", "hello")
    const { short_id } = await pub.json()
    await seedSub(meta, "canceled")
    const approve = await app.request(`/v1/artifacts/${short_id}/review/approve`, {
      method: "POST",
      ...as("u1@x.test"),
      headers: { ...as("u1@x.test").headers, "content-type": "application/json" },
      body: "{}",
    })
    expect(approve.status).toBe(402)
    const read = await app.request(`/v1/artifacts/${short_id}`, as("u2@x.test"))
    expect(read.status).toBe(200)
  })

  it("an active Team sub lifts a tiny fallback storage cap to the tier cap", async () => {
    const { app, meta } = makeAuthedApp("bg_cap", THREE, "editor", {
      deps: { billing: new FakeBilling(), maxBytes: 10 },
    })
    const blocked = await publishAs(app, "u2@x.test", "x".repeat(100))
    expect(blocked.status).toBe(413)
    await seedSub(meta, "active")
    expect((await publishAs(app, "u2@x.test", "x".repeat(100))).status).toBe(201)
  })
})
```

Adapt to the harness's real return shape: if `makeAuthedApp` returns the store under a different key than `meta`, or `publishAs` has a different signature, follow `apps/api/test/helpers.ts:263-340` and existing suites; the assertions above are the contract. If the review-approve flow needs a pending round first, mirror how `apps/api/test/review.test.ts` (or the nearest review suite) sets one up, then assert the 402.

Run: `corepack pnpm --filter @derive/api exec vitest run test/billing-gate.test.ts`
Expected: FAIL (402s come back 201/200).

- [ ] **Step 2: Implement `billingState`/`billingBlocked` in context.ts**

Beside `overStorage` (~line 700):

```ts
  const billingEnforceAt = deps.billingEnforceAt ? new Date(deps.billingEnforceAt) : null
  // The whole billing decision from local state only: the webhook-fed
  // subscription row plus a live editor-seat count. Never calls Stripe.
  const billingState = async (orgId: string): Promise<BillingState> => {
    const [sub, members] = await Promise.all([
      meta.getSubscription(orgId),
      meta.listMemberships(orgId),
    ])
    return resolveBillingState({
      subscription: sub,
      seatCount: members.filter((m) => m.role === "editor" || m.role === "owner").length,
      now: new Date(),
      enforceAt: billingEnforceAt,
      fallbackMaxBytes: deps.maxBytes,
    })
  }
  const billingBlocked = async (orgId: string): Promise<"needs_team" | "lapsed" | null> => {
    const s = await billingState(orgId)
    return s.canPublishApprove ? null : (s.blockedReason ?? null)
  }
```

Rework `overStorage` to be plan-aware (replacing the `deps.maxBytes` comparison):

```ts
  const overStorage = async (orgId: string, incoming: number): Promise<boolean> => {
    const cap = (await billingState(orgId)).storageCapBytes
    if (!cap) return false
    return (await meta.storageBytes(orgId)) + (await meta.assetStorageBytes(orgId)) + incoming > cap
  }
```

Keep the existing explanatory comment about the deliberate double-count. Export `billingState` and `billingBlocked` on the returned context object beside `overStorage`. Import `resolveBillingState`, `type BillingState` from `@derive/core`.

Add a shared copy helper (same file or `lib/http.ts`, pick context.ts since MCP needs it too):

```ts
export const BILLING_BLOCK_COPY: Record<"needs_team" | "lapsed", { code: string; message: string }> = {
  needs_team: {
    code: "billing_required",
    message:
      "This workspace has more than 3 editor seats, which needs the Team plan. An owner can upgrade in Settings, Billing.",
  },
  lapsed: {
    code: "billing_lapsed",
    message:
      "This workspace's plan has lapsed, so publishing is paused. Nothing was deleted. An owner can renew in Settings, Billing.",
  },
}
```

- [ ] **Step 3: Gate the choke points**

Same three-line shape everywhere; only the failure verb differs.

`routes/artifacts.ts`, right after `const org = existing ? ... : ...` (~line 537):

```ts
    const billingBlock = await billingBlocked(org)
    if (billingBlock) {
      const b = BILLING_BLOCK_COPY[billingBlock]
      return fail(c, 402, b.message, { code: b.code })
    }
```

(destructure `billingBlocked` from ctx at the top of the route factory like `overStorage` is.)

`routes/proposals.ts` approve handler, after the authorize check (~line 380): same block with `bail(fail(...))`.

`routes/review.ts` approve handler, after `requireArtifact` resolves (~line 97): same block with `bail(fail(...))`, org is `artifact.org_id`.

`lib/slack-proposal.ts`, before `approveProposalAction` (~line 87): the deps there carry what the Slack surface has; thread `billingBlocked` through its deps the same way `meta` arrives, and on a block, reply with the ephemeral-error pattern that file already uses for other refusals, message from `BILLING_BLOCK_COPY`.

`mcp-tools/publish.ts` (~line 420) and `mcp-tools/checkpoint.ts` (~line 136), beside the `ctx.overStorage` checks:

```ts
      const billingBlock = await ctx.billingBlocked(targetOrg)
      if (billingBlock) return err(BILLING_BLOCK_COPY[billingBlock].message)
```

(checkpoint.ts uses `text(...)` for refusals; match its local idiom.)

`lib/session-turn.ts`, before the version insert/`afterPublish` (~line 235): same check against the artifact's org; on block, return the turn's error outcome shape (mirror how it reports other refusals, e.g. `{ outcome: "error", note: ... }` per its type).

- [ ] **Step 4: Run the suite**

Run: `corepack pnpm --filter @derive/api exec vitest run test/billing-gate.test.ts`
Expected: PASS. Then the whole API suite: `corepack pnpm --filter @derive/api test` (the two known-flaky `test/mcp.test.ts` cases pass in isolation; anything else red is yours).

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): billing gate at publish/approve choke points, plan-aware storage caps"
```

---

### Task 5: Billing routes + webhook

**Files:**
- Create: `apps/api/src/routes/billing.ts`
- Modify: `apps/api/src/app.ts` (import + router list at ~line 411; `ANON_WRITE_ALLOW` entry)
- Test: `apps/api/test/billing.test.ts`

**Interfaces:**
- Consumes: ctx (`billingState`, `requireWorkspace`, `meta`, deps `billing`/`baseUrl`), Task 3 driver types, `recordFromSnapshot`.
- Produces routes: `GET /v1/billing`, `POST /v1/billing/checkout`, `POST /v1/billing/portal`, `POST /v1/billing/webhook`. GET response shape (web consumes in Task 8): `{ tier, status: string | null, interval: string | null, quantity: number | null, seats: number, current_period_end: string | null, storage: { used_bytes: number, cap_bytes: number | null }, enforce_at: string | null, beta: boolean, subscribed: boolean }`.

- [ ] **Step 1: Write the failing tests**

`apps/api/test/billing.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { FakeBilling } from "./fake-billing"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

const u = (n: number): TestUser => ({ id: `u${n}`, email: `u${n}@x.test`, name: `U${n}` })
const USERS = [u(1), u(2), u(3), u(4)]

const boot = (name: string) => {
  const fake = new FakeBilling()
  const made = makeAuthedApp(name, USERS, "editor", { deps: { billing: fake } })
  return { ...made, fake }
}

const hook = (app: { request: Function }, event: unknown, sig = "test-sig") =>
  app.request("/v1/billing/webhook", {
    method: "POST",
    headers: { "stripe-signature": sig, "content-type": "application/json" },
    body: JSON.stringify(event),
  })

const SNAP = {
  id: "sub_1",
  customerId: "cus_fake_default",
  status: "active",
  priceLookupKey: "team_monthly",
  quantity: 4,
  currentPeriodEnd: "2026-08-30T00:00:00.000Z",
  orgId: "default",
}

describe("billing routes", () => {
  it("GET /v1/billing: owner sees free-tier truth", async () => {
    const { app } = boot("br_get")
    const r = await app.request("/v1/billing", as("u1@x.test"))
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.tier).toBe("free")
    expect(body.seats).toBe(4)
    expect(body.subscribed).toBe(false)
    expect(body.beta).toBe(true)
  })

  it("GET /v1/billing: editor 403", async () => {
    const { app } = boot("br_get403")
    expect((await app.request("/v1/billing", as("u2@x.test"))).status).toBe(403)
  })

  it("checkout: owner gets a URL, quantity = live seats", async () => {
    const { app, fake } = boot("br_checkout")
    const r = await jsonAs(app, "u1@x.test", "/v1/billing/checkout", {
      tier: "team",
      interval: "month",
    })
    expect(r.status).toBe(200)
    expect((await r.json()).url).toContain("checkout.stripe.test")
    expect(fake.checkouts[0]).toMatchObject({ priceLookupKey: "team_monthly", quantity: 4 })
  })

  it("checkout: annual business maps to business_annual", async () => {
    const { app, fake } = boot("br_annual")
    await jsonAs(app, "u1@x.test", "/v1/billing/checkout", { tier: "business", interval: "year" })
    expect(fake.checkouts[0]?.priceLookupKey).toBe("business_annual")
  })

  it("checkout: non-owner 403; no driver 503", async () => {
    const { app } = boot("br_c403")
    expect(
      (await jsonAs(app, "u2@x.test", "/v1/billing/checkout", { tier: "team", interval: "month" }))
        .status,
    ).toBe(403)
    const bare = makeAuthedApp("br_nodriver", USERS, "editor")
    expect(
      (
        await jsonAs(bare.app, "u1@x.test", "/v1/billing/checkout", {
          tier: "team",
          interval: "month",
        })
      ).status,
    ).toBe(503)
  })

  it("webhook: bad signature 400, good subscription event upserts", async () => {
    const { app, meta } = boot("br_hook")
    expect((await hook(app, {}, "wrong")).status).toBe(400)
    const r = await hook(app, { type: "customer.subscription.updated", snapshot: SNAP })
    expect(r.status).toBe(200)
    const row = await meta.getSubscription("default")
    expect(row?.status).toBe("active")
    expect(row?.tier).toBe("team")
    expect(row?.quantity).toBe(4)
  })

  it("webhook: checkout.session.completed pulls the subscription by id", async () => {
    const { app, meta, fake } = boot("br_completed")
    fake.subscriptions.set("sub_1", SNAP)
    const r = await hook(app, { type: "checkout.session.completed", subscriptionId: "sub_1" })
    expect(r.status).toBe(200)
    expect((await meta.getSubscription("default"))?.stripe_subscription_id).toBe("sub_1")
  })

  it("webhook: deletion marks canceled; GET now reports it", async () => {
    const { app, meta } = boot("br_deleted")
    await hook(app, { type: "customer.subscription.updated", snapshot: SNAP })
    await hook(app, {
      type: "customer.subscription.deleted",
      snapshot: { ...SNAP, status: "canceled" },
    })
    expect((await meta.getSubscription("default"))?.status).toBe("canceled")
    const body = await (await app.request("/v1/billing", as("u1@x.test"))).json()
    expect(body.subscribed).toBe(false)
    expect(body.status).toBe("canceled")
  })

  it("checkout with an active sub: 409, the portal owns changes", async () => {
    const { app } = boot("br_409")
    await hook(app, { type: "customer.subscription.updated", snapshot: SNAP })
    expect(
      (await jsonAs(app, "u1@x.test", "/v1/billing/checkout", { tier: "team", interval: "month" }))
        .status,
    ).toBe(409)
  })

  it("anonymous webhook passes the front-door lockdown (signature is the gate)", async () => {
    const { app } = boot("br_anon")
    const r = await hook(app, { type: "ignored.event" })
    expect(r.status).toBe(200)
  })
})
```

(`jsonAs(app, email, path, body)` per `helpers.ts:308`; adjust call shape to its real signature.)

Run: `corepack pnpm --filter @derive/api exec vitest run test/billing.test.ts`
Expected: FAIL, 404s everywhere.

- [ ] **Step 2: Implement `apps/api/src/routes/billing.ts`**

Plain-Hono feature router in the style of `routes/beta.ts` (billing has no contract-first requirement; the webhook must read a raw body):

```ts
import { recordFromSnapshot } from "../lib/billing"
import { fail, readJson } from "../lib/http"
// plus: Hono, z, AppContext, log helper per neighboring routes' imports

export const billingRoutes = (ctx: AppContext) => {
  const app = new Hono()
  const { meta, billing, billingState, requireWorkspace, baseUrl } = ctx // match ctx's real property names

  const LOOKUP: Record<string, string> = {
    "team:month": "team_monthly",
    "team:year": "team_annual",
    "business:month": "business_monthly",
    "business:year": "business_annual",
  }

  // The workspace's billing truth, owner only. Also heals Stripe seat drift as a
  // side effect (Task 6 wires syncSeats here).
  app.get("/v1/billing", async (c) => {
    const org = await requireWorkspace(c, "manage")
    if (org instanceof Response) return org
    const [state, sub, stored, assets] = await Promise.all([
      billingState(org),
      meta.getSubscription(org),
      meta.storageBytes(org),
      meta.assetStorageBytes(org),
    ])
    const members = await meta.listMemberships(org)
    const seats = members.filter((m) => m.role === "editor" || m.role === "owner").length
    return c.json({
      tier: state.tier,
      status: sub?.status ?? null,
      interval: sub?.billing_interval ?? null,
      quantity: sub?.quantity ?? null,
      seats,
      current_period_end: sub?.current_period_end ?? null,
      storage: { used_bytes: stored + assets, cap_bytes: state.storageCapBytes ?? null },
      enforce_at: ctx.deps?.billingEnforceAt ?? null, // or however ctx exposes it; thread through buildContext if needed
      beta: state.whiteLabelEntitled && !state.subscriptionActive && state.canPublishApprove && state.tier === "free",
      subscribed: state.subscriptionActive,
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
    if (state.subscriptionActive)
      return fail(c, 409, "This workspace already has an active plan. Manage it from the billing portal.")
    const existing = await meta.getSubscription(org)
    const me = await ctx.actingUser(c)
    const customerId = await billing.ensureCustomer({
      orgId: org,
      email: me?.email ?? null,
      existingId: existing?.stripe_customer_id ?? null,
    })
    const members = await meta.listMemberships(org)
    const seats = Math.max(
      1,
      members.filter((m) => m.role === "editor" || m.role === "owner").length,
    )
    // Stub row: remembers the customer id across an abandoned checkout. Grants
    // nothing (status "incomplete", no subscription id).
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
      priceLookupKey: LOOKUP[`${b.tier}:${b.interval}`] as string,
      quantity: seats,
      orgId: org,
      successUrl: `${baseUrl}/settings/billing?checkout=success`,
      cancelUrl: `${baseUrl}/settings/billing`,
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
      returnUrl: `${baseUrl}/settings/billing`,
    })
    return c.json({ url })
  })

  // Stripe webhook. No auth: the signature is the gate (ANON_WRITE_ALLOW entry),
  // same pattern as the Slack/GitHub webhooks.
  app.post("/v1/billing/webhook", async (c) => {
    if (!billing) return fail(c, 503, "Billing is not configured on this deployment.")
    const sig = c.req.header("stripe-signature")
    if (!sig) return fail(c, 400, "missing stripe-signature")
    const payload = await c.req.text()
    let event: Awaited<ReturnType<typeof billing.verifyWebhook>>
    try {
      event = await billing.verifyWebhook(payload, sig)
    } catch {
      return fail(c, 400, "bad signature")
    }
    if (event.type === "checkout.session.completed" && event.subscriptionId) {
      const snap = await billing.getSubscription(event.subscriptionId)
      if (snap?.orgId) {
        const existing = await meta.getSubscription(snap.orgId)
        await meta.upsertSubscription(recordFromSnapshot(snap.orgId, snap, existing))
      }
    } else if (event.type.startsWith("customer.subscription.") && event.snapshot) {
      const snap = event.snapshot
      const orgId =
        snap.orgId ?? (await meta.getSubscriptionByStripeId(snap.id))?.org_id ?? null
      if (orgId) {
        const existing = await meta.getSubscription(orgId)
        await meta.upsertSubscription(recordFromSnapshot(orgId, snap, existing))
      }
    }
    // invoice.payment_failed and anything else: acknowledged; subscription.updated
    // carries the status change that matters.
    return c.json({ received: true })
  })

  return app
}
```

Resolve the marked uncertainties against the codebase while implementing: how other route factories destructure ctx, how `baseUrl` and the enforce date are exposed (thread `billingEnforceAt` through `buildContext`'s returned object if it isn't), and the exact `requireWorkspace` return contract. The tests are the referee.

`apps/api/src/app.ts`: import `billingRoutes`, add to the router array (~line 450), and add to `ANON_WRITE_ALLOW`:

```ts
    /^\/v1\/billing\/webhook$/, // Stripe webhook: the Stripe-Signature check is the gate
```

- [ ] **Step 3: Run tests**

Run: `corepack pnpm --filter @derive/api exec vitest run test/billing.test.ts test/billing-gate.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api
git commit -m "feat(api): billing routes, checkout, portal, Stripe webhook"
```

---

### Task 6: Seat sync

**Files:**
- Create: `apps/api/src/lib/seats.ts`
- Modify: `apps/api/src/routes/workspace.ts` (after `setMembership`/`deleteMembership` in the PUT ~line 329, PATCH ~line 353 handler, DELETE ~line 388 handler, invite-accept ~line 577 handler)
- Modify: `apps/api/src/context.ts` (`ensureMembership` fires sync after its `setMembership`; ~line 709)
- Modify: `apps/api/src/routes/billing.ts` (GET heals drift by calling `syncSeats` before reading)
- Test: `apps/api/test/billing-seats.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces:
  - `billableSeatCount(meta: MetaStore, orgId: string): Promise<number>`
  - `syncSeats(a: { meta: MetaStore; billing?: BillingDriver }, orgId: string): Promise<void>` (never throws; no-op without an active, real subscription)

- [ ] **Step 1: Write the failing tests**

`apps/api/test/billing-seats.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { FakeBilling } from "./fake-billing"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

const u = (n: number): TestUser => ({ id: `u${n}`, email: `u${n}@x.test`, name: `U${n}` })

const activeSub = (quantity: number) => ({
  org_id: "default",
  stripe_customer_id: "cus_1",
  stripe_subscription_id: "sub_1",
  tier: "team" as const,
  billing_interval: "month" as const,
  status: "active",
  quantity,
  current_period_end: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
})

describe("seat sync", () => {
  it("adding an editor bumps Stripe quantity; adding a viewer does not", async () => {
    const fake = new FakeBilling()
    const { app, meta } = makeAuthedApp("ss_add", [u(1), u(2), u(3)], "editor", {
      deps: { billing: fake },
    })
    await meta.upsertSubscription(activeSub(3))
    // PUT /v1/workspace/members adds u4 as editor (4 billable seats now).
    const r = await app.request("/v1/workspace/members", {
      method: "PUT",
      ...as("u1@x.test"),
      headers: { ...as("u1@x.test").headers, "content-type": "application/json" },
      body: JSON.stringify({ email: "u4@x.test", role: "editor" }),
    })
    // u4 must exist as a user first; if the harness needs it in the users list,
    // construct the app with five users but only three memberships via isolated
    // mode + manual setMembership, following the closest existing members test.
    expect(r.status).toBe(201)
    expect(fake.quantityCalls.at(-1)).toEqual({ subscriptionId: "sub_1", quantity: 4 })
    expect((await meta.getSubscription("default"))?.quantity).toBe(4)

    const demote = await app.request("/v1/workspace/members", {
      method: "PUT",
      ...as("u1@x.test"),
      headers: { ...as("u1@x.test").headers, "content-type": "application/json" },
      body: JSON.stringify({ email: "u4@x.test", role: "viewer" }),
    })
    expect(demote.status).toBe(201)
    expect(fake.quantityCalls.at(-1)).toEqual({ subscriptionId: "sub_1", quantity: 3 })
  })

  it("no subscription: membership changes never call Stripe", async () => {
    const fake = new FakeBilling()
    const { app } = makeAuthedApp("ss_nosub", [u(1), u(2)], "editor", {
      deps: { billing: fake },
    })
    await app.request("/v1/workspace/members", {
      method: "PUT",
      ...as("u1@x.test"),
      headers: { ...as("u1@x.test").headers, "content-type": "application/json" },
      body: JSON.stringify({ email: "u2@x.test", role: "viewer" }),
    })
    expect(fake.quantityCalls).toHaveLength(0)
  })

  it("GET /v1/billing heals drift", async () => {
    const fake = new FakeBilling()
    const { app, meta } = makeAuthedApp("ss_heal", [u(1), u(2), u(3)], "editor", {
      deps: { billing: fake },
    })
    await meta.upsertSubscription(activeSub(9)) // drifted
    const r = await app.request("/v1/billing", as("u1@x.test"))
    expect((await r.json()).quantity).toBe(3)
    expect(fake.quantityCalls.at(-1)).toEqual({ subscriptionId: "sub_1", quantity: 3 })
  })
})
```

Fix the member-addition mechanics against the real harness (whether `u4` must pre-exist in the fake auth users list; the nearest members test in `apps/api/test/workspace.test.ts` shows the working recipe). The assertions are the contract.

Run: `corepack pnpm --filter @derive/api exec vitest run test/billing-seats.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement `apps/api/src/lib/seats.ts`**

```ts
import { ACTIVE_SUBSCRIPTION_STATUSES, type MetaStore } from "@derive/core"
import type { BillingDriver } from "./billing"

export const billableSeatCount = async (meta: MetaStore, orgId: string): Promise<number> =>
  (await meta.listMemberships(orgId)).filter((m) => m.role === "editor" || m.role === "owner")
    .length

/**
 * Push the live seat count to Stripe when it drifts from the subscription's
 * quantity. Fire-and-forget semantics: a Stripe hiccup must never fail the
 * membership change that triggered it (GET /v1/billing heals on next look).
 */
export const syncSeats = async (
  a: { meta: MetaStore; billing?: BillingDriver },
  orgId: string,
): Promise<void> => {
  try {
    const sub = await a.meta.getSubscription(orgId)
    if (!sub?.stripe_subscription_id || !a.billing) return
    if (!(ACTIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(sub.status)) return
    const seats = Math.max(1, await billableSeatCount(a.meta, orgId))
    if (seats === sub.quantity) return
    await a.billing.setQuantity(sub.stripe_subscription_id, seats)
    await a.meta.upsertSubscription({ ...sub, quantity: seats, updated_at: new Date().toISOString() })
  } catch {
    // Logged upstream if the file has a logger idiom; the change itself must land.
  }
}
```

(If the file needs the repo's structured logger for the catch, copy the `log.error` idiom from `lib/slack.ts` or `app.ts`.)

- [ ] **Step 3: Hook the membership writes**

In `routes/workspace.ts`, after each successful `setMembership`/membership delete in the PUT, PATCH, DELETE, and invite-accept handlers: `await syncSeats({ meta, billing }, org)` (destructure `billing` from ctx alongside `meta`). In `context.ts` `ensureMembership`, after its `setMembership`: `await syncSeats({ meta, billing: deps.billing }, orgId)`.

In `routes/billing.ts` GET, first line after the owner check: `await syncSeats({ meta, billing }, org)`.

- [ ] **Step 4: Run tests, full suite, commit**

Run: `corepack pnpm --filter @derive/api exec vitest run test/billing-seats.test.ts test/billing.test.ts && corepack pnpm --filter @derive/api test`
Expected: PASS (same two known-flaky mcp.test.ts cases aside).

```bash
git add apps/api
git commit -m "feat(api): seat sync, Stripe quantity follows editor seats"
```

---

### Task 7: White-label entitlement mapping

**Files:**
- Modify: `apps/api/src/routes/artifacts.ts:1433` (`badge:` derivation)
- Modify: `apps/api/src/routes/embeds.ts:209-213` (embed plaque / chrome=none)
- Test: extend `apps/api/test/billing-gate.test.ts`

**Interfaces:**
- Consumes: `ctx.billingState` (Task 4).
- Produces: no new exports; behavior only. Effective white-label = `OrgSettings.whiteLabel && billingState(org).whiteLabelEntitled`.

- [ ] **Step 1: Write the failing tests** (append to `billing-gate.test.ts`)

```ts
  it("white-label honors entitlement: beta yes, enforced-free no, subscribed yes", async () => {
    const PAST = "2000-01-01T00:00:00Z"
    const boot = async (name: string, enforce: boolean) => {
      const made = makeAuthedApp(name, THREE, "editor", {
        deps: { billing: new FakeBilling(), ...(enforce ? { billingEnforceAt: PAST } : {}) },
      })
      const settings = await made.meta.getOrgSettings("default")
      await made.meta.setOrgSettings("default", { ...settings, whiteLabel: true })
      const pub = await publishAs(made.app, "u2@x.test", "hello")
      const { short_id } = await pub.json()
      return { ...made, short_id }
    }
    // Beta: the toggle works (badge false = no Made-with-Derive mark).
    const beta = await boot("wl_beta", false)
    const betaDetail = await (
      await beta.app.request(`/v1/artifacts/${beta.short_id}`, as("u1@x.test"))
    ).json()
    expect(betaDetail.badge).toBe(false)
    // Enforced without a sub: toggle set but not entitled, badge comes back.
    const enforced = await boot("wl_enforced", true)
    const enforcedDetail = await (
      await enforced.app.request(`/v1/artifacts/${enforced.short_id}`, as("u1@x.test"))
    ).json()
    expect(enforcedDetail.badge).toBe(true)
    // Same workspace with an active sub: entitled again.
    await seedSub(enforced.meta, "active")
    const paidDetail = await (
      await enforced.app.request(`/v1/artifacts/${enforced.short_id}`, as("u1@x.test"))
    ).json()
    expect(paidDetail.badge).toBe(false)
  })
```

(Confirm the artifact-detail response really carries `badge` at the top level per `artifacts.ts:1433`; adjust the read path to whatever the JSON shape is. Publishing while enforced at 3 seats is allowed, which is why `boot` publishes before seeding any sub.)

Run: FAIL (enforced case shows badge false).

- [ ] **Step 2: Implement**

`artifacts.ts:1433`, replace:

```ts
        badge: !(await meta.getOrgSettings(artifact.org_id)).whiteLabel,
```

with:

```ts
        badge: !(
          (await meta.getOrgSettings(artifact.org_id)).whiteLabel &&
          (await billingState(artifact.org_id)).whiteLabelEntitled
        ),
```

`embeds.ts:209`, same composition: `const whiteLabel = (await meta.getOrgSettings(artifact.org_id)).whiteLabel && (await billingState(artifact.org_id)).whiteLabelEntitled` and leave the two consumers below untouched. Destructure `billingState` from ctx in both route factories.

- [ ] **Step 3: Run, commit**

Run: `corepack pnpm --filter @derive/api exec vitest run test/billing-gate.test.ts`
Expected: PASS.

```bash
git add apps/api
git commit -m "feat(api): white-label follows billing entitlement"
```

---

### Task 8: The Billing settings section (web)

**Files:**
- Modify: `apps/web/src/api.ts` (types + three methods, beside `getWorkspaceSettings` ~line 944)
- Create: `apps/web/src/pages/settings/billing-section.tsx`
- Modify: `apps/web/src/pages/settings/index.tsx` (SECTION_TITLES + Workspace group + render switch)
- Test: typecheck + lint gates (`check-testids` needs `data-testid` on every interactive control)

**Interfaces:**
- Consumes: Task 5's `GET /v1/billing` shape, checkout/portal `{ url }`.
- Produces: `api.getBilling(): Promise<BillingInfo>`, `api.startCheckout(tier, interval): Promise<{ url: string }>`, `api.openBillingPortal(): Promise<{ url: string }>`; section id `billing`, testids `settings-tab-billing`, `billing-upgrade-team`, `billing-upgrade-business`, `billing-interval-toggle`, `billing-portal`.

- [ ] **Step 1: API client**

In `apps/web/src/api.ts` beside the workspace-settings methods:

```ts
  // Billing: plan truth, checkout, and the Stripe portal. Admin only.
  getBilling: (): Promise<BillingInfo> => f("/v1/billing", opts()).then(j),
  startCheckout: (tier: "team" | "business", interval: "month" | "year"): Promise<{ url: string }> =>
    f("/v1/billing/checkout", { ...opts({ tier, interval }), method: "POST" }).then(j),
  openBillingPortal: (): Promise<{ url: string }> =>
    f("/v1/billing/portal", { ...opts({}), method: "POST" }).then(j),
```

with, near the file's other response types:

```ts
export type BillingInfo = {
  tier: "free" | "team" | "business"
  status: string | null
  interval: "month" | "year" | null
  quantity: number | null
  seats: number
  current_period_end: string | null
  storage: { used_bytes: number; cap_bytes: number | null }
  enforce_at: string | null
  beta: boolean
  subscribed: boolean
}
```

- [ ] **Step 2: The section component**

`apps/web/src/pages/settings/billing-section.tsx`. Copy the structural skeleton of `general-section.tsx` (its `SettingsSection`/`SettingsGroup`/`SettingRow` imports, the `isAdmin = ws?.role === "owner"` gate, `useQuery`/`useApiMutation` idioms) and build:

- A plan card: tier name ("Free", "Team", "Business"), status line when subscribed ("Renews <date>", "Payment past due, publishing continues while Stripe retries", "Canceled"), seat line ("N editor seats" and on Free "N of 3 free editor seats used"), storage line ("X used of Y" via an existing byte-format helper if one exists in the web lib, else `(bytes / 1024 ** 3).toFixed(1) + " GB"`).
- Beta note while `beta` is true: "Free while we're in beta. Billing starts only with notice, and existing workspaces get a grace period."
- Unsubscribed: a month/year segmented toggle (`data-testid="billing-interval-toggle"`) and two upgrade buttons, "Upgrade to Team, $15 per editor monthly" / "Upgrade to Business, $30 per editor monthly" (swap copy to "$12"/"$25 per editor, billed annually" when year is selected), each calling `api.startCheckout(tier, interval).then(({ url }) => { window.location.href = url })`, testids `billing-upgrade-team` / `billing-upgrade-business`.
- Subscribed: one "Manage billing" button (`data-testid="billing-portal"`) → `api.openBillingPortal()` redirect, caption "Cards, invoices, plan changes, and cancellation happen in the Stripe portal."
- Non-owner members see the plan card, no buttons, caption "Only a workspace Admin can change billing."

No em dashes anywhere in the copy. Every interactive control carries a `data-testid` (the `lint:testids` gate fails otherwise).

- [ ] **Step 3: Register the section**

`apps/web/src/pages/settings/index.tsx`: `billing: "Billing"` in `SECTION_TITLES`; `{ id: "billing", label: "Billing", testId: "settings-tab-billing" }` after "members" in the Workspace group; `{active === "billing" && <BillingSection />}` in the render switch; import at the top matching neighbors.

- [ ] **Step 4: Verify + commit**

Run: `corepack pnpm --filter @derive/web exec tsc --noEmit && corepack pnpm lint:testids && corepack pnpm lint:frontend`
Expected: clean. Then boot the dev server briefly (`corepack pnpm dev` serves API+web per DEPLOY.md) and eyeball `/settings/billing` renders without console errors (no Stripe needed; it shows the Free card).

```bash
git add apps/web
git commit -m "feat(web): Billing section in workspace settings"
```

---

### Task 9: Seed script, docs, and the end-to-end subscribe

**Files:**
- Create: `apps/api/scripts/stripe-seed.mjs`
- Modify: `DEPLOY.md` (env reference rows for the three new vars, following its table/format)
- Verify: full-repo `corepack pnpm check` (or the repo's aggregate test command) green

**Interfaces:**
- Consumes: everything prior.
- Produces: four Stripe prices with the lookup keys Tasks 3/5 resolve.

- [ ] **Step 1: The seed script**

`apps/api/scripts/stripe-seed.mjs`:

```js
#!/usr/bin/env node
// Idempotently create the Derive billing products + prices in whatever Stripe
// account STRIPE_SECRET_KEY points at (test or live). Safe to re-run: existing
// lookup keys are left alone.
import Stripe from "stripe"

const key = process.env.STRIPE_SECRET_KEY
if (!key) {
  console.error("STRIPE_SECRET_KEY is required")
  process.exit(1)
}
const stripe = new Stripe(key)

const PLAN = [
  { product: "Derive Team", prices: [
    { lookup_key: "team_monthly", unit_amount: 1500, interval: "month" },
    { lookup_key: "team_annual", unit_amount: 14400, interval: "year" },
  ]},
  { product: "Derive Business", prices: [
    { lookup_key: "business_monthly", unit_amount: 3000, interval: "month" },
    { lookup_key: "business_annual", unit_amount: 30000, interval: "year" },
  ]},
]

const existing = await stripe.prices.list({
  lookup_keys: PLAN.flatMap((p) => p.prices.map((x) => x.lookup_key)),
  limit: 10,
})
const have = new Set(existing.data.map((p) => p.lookup_key))

for (const plan of PLAN) {
  const missing = plan.prices.filter((p) => !have.has(p.lookup_key))
  if (!missing.length) {
    console.log(`${plan.product}: all prices exist`)
    continue
  }
  const product = await stripe.products.create({ name: plan.product })
  for (const p of missing) {
    await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: p.unit_amount,
      recurring: { interval: p.interval },
      lookup_key: p.lookup_key,
      transfer_lookup_key: true,
    })
    console.log(`created ${p.lookup_key} (${p.unit_amount} cents / ${p.interval})`)
  }
}
console.log("done")
```

(Note the small idempotency wrinkle: if ONE of a product's prices exists, the script creates a second product for the missing ones. Fine for v1; lookup keys stay unique either way.)

- [ ] **Step 2: DEPLOY.md**

Add `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `DERIVE_BILLING_ENFORCE_AT` to the env reference (~line 90) in the file's row format, and a short "Billing (Stripe)" subsection under the hosted-tier docs: seed command (`STRIPE_SECRET_KEY=sk_... node apps/api/scripts/stripe-seed.mjs`), webhook endpoint URL (`https://<host>/v1/billing/webhook`), events to subscribe (`checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`), and the enforcement-day runbook line from the spec.

- [ ] **Step 3: Full verification**

Run: `corepack pnpm check` (whatever the repo's aggregate gate is; it's what blocks deploy)
Expected: green, coverage floors intact.

- [ ] **Step 4: Commit**

```bash
git add apps/api/scripts/stripe-seed.mjs DEPLOY.md
git commit -m "feat(api): Stripe seed script + billing deploy docs"
```

- [ ] **Step 5: The E2E subscribe (needs Connor's sk_test key)**

1. Put keys in `apps/api/.env` (or however `src/node.ts` loads env, check `.env.example` guidance): `STRIPE_SECRET_KEY=sk_test_...`.
2. `node apps/api/scripts/stripe-seed.mjs` → four prices created.
3. `stripe listen --forward-to localhost:8787/v1/billing/webhook` (Stripe CLI; it prints a `whsec_...`, put it in `STRIPE_WEBHOOK_SECRET`, restart the dev server). Confirm the API's actual dev port from its boot log first.
4. `corepack pnpm dev`, sign in, Settings → Billing, Upgrade to Team monthly.
5. Checkout with card `4242 4242 4242 4242`, any future expiry, any CVC.
6. Verify: redirected back to `/settings/billing?checkout=success`; the section shows Team active with the right seat count; `GET /v1/billing` (browser devtools) shows `subscribed: true, tier: "team"`; the `stripe listen` log shows the webhook 200s.
7. In the Stripe test dashboard, cancel the subscription; verify the webhook flips the section to Canceled.

This is the spec's done criterion. Record the result in the final report.

---

## Plan Self-Review (done at write time)

- Spec coverage: table+store (T2), gate (T1), enforcement+storage (T4), routes+webhook (T5), seat sync (T6), white-label (T7), config (T3), web (T8), seed+docs+E2E (T9). Flags section of the spec is launch-day work, deliberately unplanned.
- Known executor-resolution points (marked inline): harness return shape in tests, ctx property names when destructuring, worker.ts env plumbing, Stripe SDK type drift on `current_period_end`, artifact-detail JSON shape in the white-label test, dev port in E2E step 3. Each names its referee (existing neighboring code or a failing test).
- Type consistency: `BillingDriver`/`SubscriptionSnapshot`/`BillingEvent` defined once in Task 3, consumed by 5/6; `SubscriptionRecord` defined in Task 1, consumed everywhere; copy map `BILLING_BLOCK_COPY` defined in Task 4, used by all gate sites.
