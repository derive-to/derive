# Upgrade-Path CTAs + Billing Page Breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every billing block becomes an upgrade moment (global dialog + non-dismissable banner + invite-time seat gate), and the billing settings page becomes a real plan-comparison surface with the pricing page's per-tier feature lists.

**Architecture:** The server exposes its gate verdict (`blocked` on `GET /v1/billing`) and machine codes on every billing refusal; the web intercepts those codes in the one global mutation-error funnel and opens a single reason-aware UpgradeDialog. A new invite-time seat gate refuses the 4th billable seat post-enforcement. All block copy is built once from `baseUrl` so agent-facing messages carry the direct `/settings/billing` URL.

**Tech Stack:** Hono (plain, no OpenAPI for billing route), Drizzle-backed MetaStore, React + TanStack Router/Query, shadcn dialog, vitest. Branch `feat/upgrade-cta`, stacked on `feat/billing-rail`.

**Spec:** `docs/superpowers/specs/2026-07-30-upgrade-cta-billing-page-design.md` — binding. Read it if a requirement here seems ambiguous.

## Global Constraints

- No em dashes anywhere in user-facing copy: commas/colons/periods. (En dashes allowed in numeric ranges.)
- Copy strings below are EXACT. Use them verbatim, including punctuation.
- Web never imports `@derive/core` (dependency-cruiser rule). Display constants are pinned web-side with mirror comments, the existing idiom in `apps/web/src/pages/settings/billing-section.tsx`.
- `apps/api/src/routes/billing.ts` stays plain Hono; `BillingInfo` stays hand-declared in `apps/web/src/api.ts`.
- All commands via `corepack pnpm`. Run tests with `corepack pnpm --filter @derive/api test <file>` / `--filter @derive/web` / `--filter @derive/core`.
- No new runtime dependencies. No new test harnesses (web tests are pure-logic `.test.ts` colocated files).
- Testids: kebab-case `data-testid` literals; the repo's `lint:testids` gate must pass (`corepack pnpm run ci` runs it).
- Known flake: `apps/api/test/mcp.test.ts` can fail under full-suite coverage load (pre-existing on main); it passes in isolation and must not be "fixed" here.
- Commit after every green test cycle. Trailer on every commit:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01VMUBaVBw7bCW7HqWPvwiKe`

---

### Task 1: `betaGrace` on BillingState (core)

**Files:**
- Modify: `packages/core/src/billing.ts`
- Modify: `apps/api/src/routes/billing.ts` (the `beta` derivation)
- Test: `packages/core/test/billing.test.ts`

**Interfaces:**
- Consumes: existing `resolveBillingState(args): BillingState`.
- Produces: `BillingState.betaGrace: boolean` — true exactly in the pre-enforcement, no-active-subscription branch. Task 4's seat gate and the billing route's `beta` flag rely on it.

- [ ] **Step 1: Write the failing tests** (append to `packages/core/test/billing.test.ts`, matching its existing describe/it style):

```ts
it("betaGrace is true only pre-enforcement without an active subscription", () => {
  const now = new Date("2026-07-30T00:00:00Z")
  const pre = resolveBillingState({ subscription: null, seatCount: 1, now, enforceAt: null })
  expect(pre.betaGrace).toBe(true)

  const enforced = resolveBillingState({
    subscription: null,
    seatCount: 1,
    now,
    enforceAt: new Date("2026-07-01T00:00:00Z"),
  })
  expect(enforced.betaGrace).toBe(false)

  const active = resolveBillingState({
    subscription: { ...baseSub, status: "active" },
    seatCount: 5,
    now,
    enforceAt: null,
  })
  expect(active.betaGrace).toBe(false)
})
```

`baseSub` = whatever subscription fixture the file already uses (reuse it; do not invent a new one).

- [ ] **Step 2: Run to verify failure**

Run: `corepack pnpm --filter @derive/core test billing.test.ts`
Expected: FAIL — `betaGrace` is `undefined`.

- [ ] **Step 3: Implement.** In `packages/core/src/billing.ts`:

Add to the interface:

```ts
export interface BillingState {
  tier: BillingTier
  subscriptionActive: boolean
  canPublishApprove: boolean
  blockedReason?: "needs_team" | "lapsed"
  /** undefined = unlimited (self-host with no DERIVE_MAX_BYTES). */
  storageCapBytes?: number
  whiteLabelEntitled: boolean
  /** The published beta promise is in effect: enforcement has not started and no
   *  subscription is active. The billing route's `beta` flag and the seat gate
   *  read this instead of re-deriving it from other fields. */
  betaGrace: boolean
}
```

Set it in all three branches of `resolveBillingState`: `betaGrace: false` in the active-subscription return, `betaGrace: true` in the `!enforced` return, and `betaGrace: false` in the `base` object of the enforced branch.

- [ ] **Step 4: Update the consumer.** In `apps/api/src/routes/billing.ts`, replace

```ts
const beta = state.whiteLabelEntitled && !state.subscriptionActive
```

with

```ts
const beta = state.betaGrace
```

- [ ] **Step 5: Run core + api tests**

Run: `corepack pnpm --filter @derive/core test billing.test.ts && corepack pnpm --filter @derive/api test billing.test.ts`
Expected: PASS (the api billing suite exercises `beta` end to end).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/billing.ts packages/core/test/billing.test.ts apps/api/src/routes/billing.ts
git commit -m "feat(core): expose betaGrace on BillingState"
```

---

### Task 2: block-copy builder with billing URL, storage codes, typed billing failure

**Files:**
- Modify: `apps/api/src/context.ts` (replace `BILLING_BLOCK_COPY` const with `billingBlockCopy(baseUrl)` builder; build once; expose `blockCopy` on the context)
- Modify: `apps/api/src/lib/billing.ts` (add `BillingBlockedError`)
- Modify: `apps/api/src/lib/turn-core.ts` (tag billing-blocked write failures)
- Modify: `apps/api/src/lib/session-turn.ts` (throw typed error; apologyFor reads the tag)
- Modify: `apps/api/src/routes/artifacts.ts` (2 storage 413 sites, near lines 596/606), `apps/api/src/routes/assets.ts` (line ~90), `apps/api/src/routes/proposals.ts` (lines ~223/235)
- Modify: `apps/api/src/mcp-tools/publish.ts` (line ~446), `apps/api/src/mcp-tools/checkpoint.ts` (line ~140)
- Test: `apps/api/test/quotas.test.ts`, `apps/api/test/billing-gate.test.ts`

**Interfaces:**
- Consumes: `deps.baseUrl` (already on AppDeps), `state.blockedReason` from Task 1's core.
- Produces: `billingBlockCopy(baseUrl)` returning `{ needs_team, lapsed, seat_limit, storage }`, each `{ code, message }`; `ctx.blockCopy` (the built record) available to every route/mcp-tool via the context; `BillingBlockedError` class in `lib/billing.ts`; `TurnOutcome.failure.billingBlocked?: boolean`. Tasks 3 and 4 use `ctx.blockCopy`.

- [ ] **Step 1: Write the failing tests.**

In `apps/api/test/quotas.test.ts`, find the existing over-storage-cap test (it asserts a 413 with "storage quota exceeded") and extend/adjacent-add:

```ts
it("storage overflow carries the machine code and the billing URL", async () => {
  // reuse the file's existing over-cap arrangement verbatim
  const res = /* the same over-cap request the neighboring test makes */
  expect(res.status).toBe(413)
  const body = await res.json()
  expect(body.code).toBe("storage_exceeded")
  expect(body.error).toContain("/settings/billing")
})
```

In `apps/api/test/billing-gate.test.ts`, extend the existing blocked-MCP-publish assertion so the tool error text also matches `/\/settings\/billing/`.

- [ ] **Step 2: Run to verify failure**

Run: `corepack pnpm --filter @derive/api test quotas.test.ts billing-gate.test.ts`
Expected: FAIL — no `code` on the 413, no URL in the message.

- [ ] **Step 3: The copy builder.** In `apps/api/src/context.ts`, replace the exported `BILLING_BLOCK_COPY` const entirely with:

```ts
/** The refusal copy for blocked billing actions, keyed by reason. Built from baseUrl
 *  so every surface (HTTP 402/413 bodies, MCP tool errors, session-turn apologies)
 *  hands the human the direct upgrade link. Lives here (not lib/http.ts) because the
 *  MCP surfaces need it too, and both import from context.ts already. No em dashes
 *  (support copy convention). */
export const billingBlockCopy = (baseUrl: string) => {
  const billingUrl = `${baseUrl.replace(/\/$/, "")}/settings/billing`
  return {
    needs_team: {
      code: "billing_required",
      message: `This workspace has more than 3 editor seats, so publishing is paused until it upgrades to the Team plan. An owner can upgrade at ${billingUrl}.`,
    },
    lapsed: {
      code: "billing_lapsed",
      message: `This workspace's plan has lapsed, so publishing is paused. Nothing was deleted. An owner can renew at ${billingUrl}.`,
    },
    seat_limit: {
      code: "billing_required",
      message: `Free covers 3 editor seats, so this workspace needs the Team plan to add more editors. An owner can upgrade at ${billingUrl}.`,
    },
    storage: {
      code: "storage_exceeded",
      message: `This workspace is out of storage, so this save was refused. Upgrade for more at ${billingUrl}.`,
    },
  } as const
}
```

Inside `createContext` (near where `billingState` is defined): `const blockCopy = billingBlockCopy(deps.baseUrl)`. Change `billingBlocked` to read `blockCopy[s.blockedReason]` instead of `BILLING_BLOCK_COPY[s.blockedReason]`. Add `blockCopy` to the returned context object (AppContext is inferred, so exposure is automatic).

- [ ] **Step 4: The typed failure.** In `apps/api/src/lib/billing.ts` add:

```ts
/** A write refused by the billing gate. Distinct from a real write failure so turn
 *  lanes can surface the copy verbatim and skip the retry (retrying cannot help
 *  until the plan changes). */
export class BillingBlockedError extends Error {}
```

In `apps/api/src/lib/session-turn.ts`: import it, and at the gate site (`if (blocked) throw new Error(blocked.message)`) throw `new BillingBlockedError(blocked.message)`. In `apologyFor`, delete the `BILLING_BLOCK_COPY` import and the `billingMessages` exact-match pair of lines; replace with:

```ts
    if (failure.billingBlocked) return failure.error
```

(keep the explanatory comment above it, reworded to say the flag comes from turn-core's catch).

In `apps/api/src/lib/turn-core.ts`: add `billingBlocked?: boolean` to the `failure` field of `TurnOutcome`, import `BillingBlockedError` from `./billing`, and in the landing `catch (e)` block build:

```ts
      failure: {
        reason: "write",
        error: e instanceof Error ? e.message : String(e),
        retryable: !(e instanceof BillingBlockedError),
        ...(e instanceof BillingBlockedError ? { billingBlocked: true } : {}),
      },
```

(the comment above it should note a billing block is not retryable: the model turn succeeded, and retrying cannot land until the plan changes).

- [ ] **Step 5: Storage sites.** At each of the five REST sites, replace `fail(c, 413, "storage quota exceeded")` with `fail(c, 413, blockCopy.storage.message, { code: blockCopy.storage.code })`, destructuring `blockCopy` from the route's `ctx` alongside its existing pulls. In `mcp-tools/publish.ts` replace the `err(\`"${short_id}"'s workspace storage quota is exceeded.\`)` text with `err(ctx.blockCopy.storage.message)` (match how that file already reaches ctx); in `mcp-tools/checkpoint.ts` replace `text("The workspace's storage quota is exceeded — checkpoint not saved.")` with `text(ctx.blockCopy.storage.message)` (this also removes an em dash, per the copy convention).

- [ ] **Step 6: Sweep.** `grep -rn "BILLING_BLOCK_COPY" apps/` must return nothing. `grep -rn "storage quota exceeded" apps/api/src` must return nothing (tests may still reference the new message).

- [ ] **Step 7: Run the affected suites**

Run: `corepack pnpm --filter @derive/api test quotas.test.ts billing-gate.test.ts billing.test.ts sessions.test.ts`
Expected: PASS. If a session/turn test asserted the old apology path, update it to set `billingBlocked: true` on the failure fixture rather than matching copy strings.

- [ ] **Step 8: Commit**

```bash
git add -A apps/api/src apps/api/test
git commit -m "feat(api): billing block copy carries the billing URL; storage refusals get a machine code"
```

---

### Task 3: `blocked` on GET /v1/billing

**Files:**
- Modify: `apps/api/src/routes/billing.ts`
- Test: `apps/api/test/billing.test.ts`

**Interfaces:**
- Consumes: `ctx.blockCopy` (Task 2), `state.blockedReason` (existing).
- Produces: response field `blocked: { code: "billing_required" | "billing_lapsed"; message: string } | null`. Task 5's web type and Task 7's banner depend on this exact shape.

- [ ] **Step 1: Write the failing tests** (in `apps/api/test/billing.test.ts`, using its existing app/workspace/seat fixtures — it already has enforcement-date and seat-count arrangements from the rail):

```ts
describe("GET /v1/billing blocked", () => {
  it("is null during beta grace even over the seat limit", async () => {
    /* app with no DERIVE_BILLING_ENFORCE_AT, 4 billable seats */
    expect(body.blocked).toBeNull()
  })
  it("is null while subscribed", async () => {
    /* active subscription row, 5 seats, enforcement in the past */
    expect(body.blocked).toBeNull()
  })
  it("reports billing_required past enforcement with 4 seats", async () => {
    expect(body.blocked?.code).toBe("billing_required")
    expect(body.blocked?.message).toContain("/settings/billing")
  })
  it("reports billing_lapsed for a canceled subscription past enforcement", async () => {
    expect(body.blocked?.code).toBe("billing_lapsed")
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `corepack pnpm --filter @derive/api test billing.test.ts`
Expected: FAIL — `blocked` is `undefined`.

- [ ] **Step 3: Implement.** In the GET handler, destructure `blockCopy` from ctx and add to the `c.json({...})` payload, after `subscribed`:

```ts
      blocked: state.blockedReason ? blockCopy[state.blockedReason] : null,
```

- [ ] **Step 4: Run to verify pass**

Run: `corepack pnpm --filter @derive/api test billing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/billing.ts apps/api/test/billing.test.ts
git commit -m "feat(api): GET /v1/billing exposes the gate verdict as blocked"
```

---

### Task 4: invite-time seat gate

**Files:**
- Modify: `apps/api/src/context.ts` (the `seatGrantGate` helper, beside `billingGate`)
- Modify: `apps/api/src/routes/workspace.ts` (three call sites)
- Test: `apps/api/test/billing-seats.test.ts`

**Interfaces:**
- Consumes: `billingState(orgId, pre?)`, `blockCopy.seat_limit` (Task 2), `betaGrace` (Task 1), `isBillableRole`/`billableSeatCount` from `apps/api/src/lib/seats.ts` (already imported by context.ts), `FREE_SEAT_LIMIT` from `@derive/core`.
- Produces: `ctx.seatGrantGate(c, orgId, role, existingRole?) => Promise<Response | null>`.

- [ ] **Step 1: Write the failing tests** (in `apps/api/test/billing-seats.test.ts`, which already builds workspaces with member rosters; an "enforced" app passes `billingEnforceAt` in the past, exactly as billing.test.ts does). Six cases:

```ts
describe("seat gate on granting a billable role", () => {
  it("beta: the 4th editor invite succeeds", /* no enforce date; PUT members role=editor with 3 existing billable seats -> 201 */)
  it("enforced: the 4th billable grant 402s with billing_required", /* expect 402, body.code billing_required, body.error contains /settings/billing */)
  it("enforced: a commenter invite always succeeds", /* role=commenter at 3 seats -> 201 */)
  it("enforced: a subscribed workspace adds a 4th editor freely", /* active sub row -> 201 */)
  it("enforced: promoting a commenter to editor at the limit 402s", /* PATCH members/{id} role=editor -> 402 */)
  it("enforced: re-roling an existing editor to owner passes", /* both roles billable, adds no seat -> 200 */)
})
```

Use the routes, not the helper directly: `PUT /v1/workspace/members` and `PATCH /v1/workspace/members/{userId}` via the file's authed-app harness.

- [ ] **Step 2: Run to verify failure**

Run: `corepack pnpm --filter @derive/api test billing-seats.test.ts`
Expected: the enforced-402 cases FAIL (grants currently always succeed).

- [ ] **Step 3: The gate.** In `apps/api/src/context.ts`, beside `billingGate` (add `FREE_SEAT_LIMIT` to the existing `@derive/core` import):

```ts
  // Granting `role` must not add a billable seat the workspace's plan doesn't cover.
  // The target's current role rides along so a re-role of an already-billable member
  // (editor to owner) sails through: it adds nothing. Subscribed workspaces always
  // pass; the grant just becomes a billed seat on the next syncSeats. Beta grace
  // passes: this gate arrives with enforcement, like every other billing gate.
  const seatGrantGate = async (
    c: Context,
    orgId: string,
    role: Role,
    existingRole?: Role | null,
  ): Promise<Response | null> => {
    if (!isBillableRole(role) || (existingRole && isBillableRole(existingRole))) return null
    const [sub, seats] = await Promise.all([
      meta.getSubscription(orgId),
      billableSeatCount(meta, orgId),
    ])
    const s = await billingState(orgId, { sub, seatCount: seats })
    if (s.subscriptionActive || s.betaGrace || seats < FREE_SEAT_LIMIT) return null
    return fail(c, 402, blockCopy.seat_limit.message, { code: blockCopy.seat_limit.code })
  }
```

Add `seatGrantGate` to the returned context object.

- [ ] **Step 4: Wire the three routes** in `apps/api/src/routes/workspace.ts` (destructure `seatGrantGate` from ctx at the top of the routes factory):

PUT `/v1/workspace/members`, after the last-Admin guard and before `setMembership`:

```ts
      const gated = await seatGrantGate(c, org, b.role, existing?.role)
      if (gated) return bail(gated)
```

PATCH `/v1/workspace/members/{userId}`, same position:

```ts
      const gated = await seatGrantGate(c, org, b.role, existing.role)
      if (gated) return bail(gated)
```

POST `/v1/workspace/invites`: hoist the membership lookup so the gate covers BOTH branches (direct-add and pending-email; a pending editor invite would otherwise be accepted later into a seat the plan doesn't cover). After `const existingId = await resolveUserRef(meta, ref)`:

```ts
      const existingMembership = existingId ? await meta.getMembership(org, existingId) : null
      const gated = await seatGrantGate(c, org, b.role, existingMembership?.role)
      if (gated) return bail(gated)
```

and in the direct-add branch replace the inline `(await meta.getMembership(org, existingId))?.id` with `existingMembership?.id`.

- [ ] **Step 5: Run to verify pass**

Run: `corepack pnpm --filter @derive/api test billing-seats.test.ts billing.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/context.ts apps/api/src/routes/workspace.ts apps/api/test/billing-seats.test.ts
git commit -m "feat(api): the 4th billable seat requires Team once enforcement starts"
```

---

### Task 5: web paywall store + global interceptor

**Files:**
- Create: `apps/web/src/lib/paywall.ts`
- Modify: `apps/web/src/lib/query-client.ts`
- Modify: `apps/web/src/api.ts` (BillingInfo)
- Test: `apps/web/src/lib/query-client.test.ts`

**Interfaces:**
- Consumes: `ApiError.code` (already thrown by the api module).
- Produces: `PaywallReason = "seats" | "lapsed" | "storage"`; `openPaywall(reason)`, `closePaywall()`, `usePaywall(): PaywallReason | null` from `lib/paywall.ts`; `paywallReasonFor(err): PaywallReason | null` exported from `query-client.ts`; `BillingInfo.blocked: { code: "billing_required" | "billing_lapsed"; message: string } | null`. Tasks 6-9 consume all of these.

- [ ] **Step 1: Write the failing tests** (append to `apps/web/src/lib/query-client.test.ts`, same style as the `shouldToastError` tests):

```ts
describe("paywallReasonFor", () => {
  class FakeApiError extends Error {
    constructor(readonly status: number, readonly code?: string) { super("x") }
  }
  it("maps the three billing codes", () => {
    expect(paywallReasonFor(new FakeApiError(402, "billing_required"))).toBe("seats")
    expect(paywallReasonFor(new FakeApiError(402, "billing_lapsed"))).toBe("lapsed")
    expect(paywallReasonFor(new FakeApiError(413, "storage_exceeded"))).toBe("storage")
  })
  it("passes every other failure through to the toast path", () => {
    expect(paywallReasonFor(new FakeApiError(413, undefined))).toBeNull()
    expect(paywallReasonFor(new FakeApiError(409, "conflict"))).toBeNull()
    expect(paywallReasonFor(new Error("network down"))).toBeNull()
    expect(paywallReasonFor(undefined)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `corepack pnpm --filter @derive/web test query-client.test.ts`
Expected: FAIL — `paywallReasonFor` not exported.

- [ ] **Step 3: The store.** Create `apps/web/src/lib/paywall.ts`:

```ts
import { useSyncExternalStore } from "react"

/** Why the paywall opened: over the free seat limit, a lapsed plan, or a storage
 *  cap. Drives the UpgradeDialog's headline; the mapping from server codes lives
 *  in query-client.ts (paywallReasonFor), the one place mutation errors funnel. */
export type PaywallReason = "seats" | "lapsed" | "storage"

// A module store, not context: the opener is the global MutationCache (outside
// React), and the single subscriber is the UpgradeDialog. useSyncExternalStore
// keeps it concurrent-safe without adding a state library.
let current: PaywallReason | null = null
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}

export const openPaywall = (reason: PaywallReason): void => {
  current = reason
  emit()
}
export const closePaywall = (): void => {
  current = null
  emit()
}

export const usePaywall = (): PaywallReason | null =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current,
  )
```

- [ ] **Step 4: The interceptor.** In `apps/web/src/lib/query-client.ts`, import `openPaywall` and `type PaywallReason` from `./paywall`, add beside the other pure helpers:

```ts
/** Billing refusals become the upgrade dialog, not a toast: the server tags them
 *  with a machine code (fail()'s `code`), and this is the one mapping from those
 *  codes to the dialog's reasons. Everything else returns null and keeps the
 *  normal toast path. Pure + exported so it's unit-tested. */
export const paywallReasonFor = (err: unknown): PaywallReason | null => {
  const code = (err as { code?: unknown })?.code
  if (code === "billing_required") return "seats"
  if (code === "billing_lapsed") return "lapsed"
  if (code === "storage_exceeded") return "storage"
  return null
}
```

and change the MutationCache:

```ts
  mutationCache: new MutationCache({
    onError: (err, _vars, _ctx, mutation) => {
      const reason = paywallReasonFor(err)
      if (reason) return openPaywall(reason)
      if (shouldToastError(mutation.meta)) toast.error(toastMessageFor(err))
    },
  }),
```

- [ ] **Step 5: The type.** In `apps/web/src/api.ts`, add to `BillingInfo` after `subscribed`:

```ts
  blocked: { code: "billing_required" | "billing_lapsed"; message: string } | null
```

- [ ] **Step 6: Run to verify pass**

Run: `corepack pnpm --filter @derive/web test query-client.test.ts && corepack pnpm --filter @derive/web exec tsc --noEmit -p .`
Expected: tests PASS; typecheck clean (use the web package's own typecheck script if one exists instead of raw tsc; check `apps/web/package.json`).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/paywall.ts apps/web/src/lib/query-client.ts apps/web/src/lib/query-client.test.ts apps/web/src/api.ts
git commit -m "feat(web): billing refusals open the paywall instead of a toast"
```

---

### Task 6: plan constants + UpgradeDialog

**Files:**
- Create: `apps/web/src/pages/settings/billing-plans.ts`
- Create: `apps/web/src/lib/bytes.ts`
- Create: `apps/web/src/components/billing/upgrade-dialog.tsx`
- Modify: `apps/web/src/components/chrome/app-shell.tsx` (mount)
- Modify: `apps/web/src/pages/settings/billing-section.tsx` (import `gb` from lib/bytes instead of its local copy)

**Interfaces:**
- Consumes: `usePaywall`/`closePaywall` (Task 5), `billingQuery`/`workspaceQuery` (existing), `api.startCheckout(tier, interval)` (existing), shadcn `Dialog` family, `useApiMutation`.
- Produces: `PLANS` array (used again by Task 8), `gb(bytes)` in `lib/bytes.ts`, `<UpgradeDialog />` mounted globally.

- [ ] **Step 1: `apps/web/src/lib/bytes.ts`** (the second caller has arrived, so the helper moves to lib as billing-section's comment promised):

```ts
/** bytes → "1.2 GB". Display-only; billing surfaces (plan card, upgrade dialog)
 *  share it so the two can't round differently. */
export const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`
```

Update `billing-section.tsx` to `import { gb } from "@/lib/bytes"` and delete its local `gb` const (and the "move this there" comment).

- [ ] **Step 2: `apps/web/src/pages/settings/billing-plans.ts`.** Feature lists mirror `apps/web/public/site/pricing.html` verbatim (the published commitment; spec locks parity). The one deviation, per spec: no storage-overage clause.

```ts
/** The tier cards, shared by the billing page grid and the UpgradeDialog so the
 *  two surfaces can't drift. Copy mirrors the public pricing page
 *  (apps/web/public/site/pricing.html) verbatim; the storage-overage clause is
 *  deliberately omitted in-app because overage billing does not exist. Prices are
 *  display-only mirrors of the Stripe lookup keys seeded by the billing rail. */
export type PaidTier = "team" | "business"

export const PLANS = [
  {
    tier: "free",
    name: "Free",
    tagline: "For individuals, open-source projects, and small teams.",
    price: { month: "$0 forever", year: "$0 forever" },
    features: [
      "Up to 3 editors per workspace",
      "Unlimited viewers and commenters",
      "The full review loop: comments, proposals, approvals",
      "CLI, API, and MCP for your agents",
      "Permanent URLs with full version history",
      "1 GB storage, deduplicated",
    ],
  },
  {
    tier: "team",
    name: "Team",
    badge: "Most teams",
    tagline: "For teams whose agents ship work that needs review.",
    price: { month: "$15 per editor / month", year: "$12 per editor / month, billed annually" },
    everythingIn: "Everything in Free, plus",
    features: [
      "Unlimited editors",
      "Custom domain",
      "White-label shared pages",
      "Password-protected links",
      "Brandprint: your house style, read by every agent",
      "50 GB pooled storage",
      "Full analytics history",
    ],
  },
  {
    tier: "business",
    name: "Business",
    tagline: "For organizations that need control and accountability.",
    price: { month: "$30 per editor / month", year: "$25 per editor / month, billed annually" },
    everythingIn: "Everything in Team, plus",
    features: [
      "250 GB pooled storage",
      "SSO with your identity provider (OIDC)",
      "Audit log",
      "Multiple custom domains",
      "Guest editor management",
      "Uptime SLA",
      "Priority support",
    ],
  },
] as const

export type Plan = (typeof PLANS)[number]
```

- [ ] **Step 3: `apps/web/src/components/billing/upgrade-dialog.tsx`.** The complete component:

```tsx
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { api } from "@/api"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { gb } from "@/lib/bytes"
import { closePaywall, type PaywallReason, usePaywall } from "@/lib/paywall"
import { billingQuery, workspaceQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { PLANS } from "@/pages/settings/billing-plans"

// One dialog for every paywall hit, opened by the global mutation-error funnel
// (query-client.ts). The reason decides the headline; the sell is always the
// Team list, with Business as the step-up. Owners check out right here; everyone
// else learns who can.
export function UpgradeDialog() {
  const reason = usePaywall()
  return reason ? <UpgradeDialogBody reason={reason} /> : null
}

// Split so the data queries mount only while the dialog is open.
function UpgradeDialogBody({ reason }: { reason: PaywallReason }) {
  const { data: billing } = useQuery(billingQuery())
  const { data: ws } = useQuery(workspaceQuery())
  const [cycle, setCycle] = useState<"month" | "year">("month")
  const isAdmin = ws?.role === "owner"
  const admins = (ws?.members ?? [])
    .filter((m) => m.role === "owner")
    .map((m) => m.name ?? m.handle ?? "a workspace admin")

  const checkout = useApiMutation<
    { url: string },
    { tier: "team" | "business"; interval: "month" | "year" }
  >({
    mutationFn: ({ tier, interval }) => api.startCheckout(tier, interval),
    pendingKey: (vars) => vars.tier,
    onSuccess: ({ url }) => {
      window.location.href = url
    },
  })

  const heads: Record<PaywallReason, { title: string; sub: string }> = {
    seats: {
      title: "Your team outgrew Free",
      sub: billing ? `You have ${billing.seats} editor seats. Free covers 3.` : "Free covers 3 editor seats.",
    },
    lapsed: {
      title: "Your plan has lapsed",
      sub: "Nothing was deleted. Renew to resume publishing.",
    },
    storage: {
      title: "You've hit your storage limit",
      sub:
        billing?.storage.cap_bytes != null
          ? `${gb(billing.storage.used_bytes)} of ${gb(billing.storage.cap_bytes)} used. Team includes 50 GB pooled storage.`
          : "Team includes 50 GB pooled storage.",
    },
  }
  const team = PLANS.find((p) => p.tier === "team")
  const business = PLANS.find((p) => p.tier === "business")

  return (
    <Dialog open onOpenChange={(open) => !open && closePaywall()}>
      <DialogContent data-testid="paywall-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{heads[reason].title}</DialogTitle>
          <DialogDescription>{heads[reason].sub}</DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-1.5 text-sm">
          {team?.features.map((f) => (
            <li key={f} className="flex items-start gap-2">
              <Icon name="check" size={16} className="mt-0.5 shrink-0 text-primary" />
              <span>{f}</span>
            </li>
          ))}
        </ul>
        {isAdmin ? (
          <div className="flex flex-col items-start gap-3">
            <ToggleGroup
              type="single"
              value={cycle}
              onValueChange={(v) => v && setCycle(v as "month" | "year")}
              data-testid="paywall-interval-toggle"
              className="gap-[3px] rounded-lg bg-secondary p-[3px]"
            >
              <ToggleGroupItem value="month" className="rounded-md text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-(--shadow-sm)">
                Monthly
              </ToggleGroupItem>
              <ToggleGroupItem value="year" className="rounded-md text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-(--shadow-sm)">
                Annual
              </ToggleGroupItem>
            </ToggleGroup>
            <div className="flex flex-wrap gap-2">
              <Button
                data-testid="paywall-checkout-team"
                size="sm"
                loading={checkout.isPendingFor("team")}
                disabled={checkout.isPending}
                onClick={() => checkout.mutate({ tier: "team", interval: cycle })}
              >
                Upgrade to Team
              </Button>
              <Button
                data-testid="paywall-checkout-business"
                variant="outline"
                size="sm"
                loading={checkout.isPendingFor("business")}
                disabled={checkout.isPending}
                onClick={() => checkout.mutate({ tier: "business", interval: cycle })}
              >
                Upgrade to Business
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              {team?.price[cycle]} · Business {business?.price[cycle]}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Ask a workspace admin to upgrade.{admins.length > 0 && ` That's ${admins.join(", ")}.`}
          </p>
        )}
        <Link
          to="/settings/$section"
          params={{ section: "billing" }}
          data-testid="paywall-see-plans"
          className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={() => closePaywall()}
        >
          Compare all plans
        </Link>
      </DialogContent>
    </Dialog>
  )
}
```

Adjust to reality where the codebase differs (exact `Icon` name for a checkmark, `ws.members` field names: check the `Workspace` schema for `handle` vs `username`; the Button `loading` prop exists, billing-section uses it). Keep testids exactly as written.

- [ ] **Step 4: Mount.** In `app-shell.tsx`, import `{ UpgradeDialog } from "@/components/billing/upgrade-dialog"` and render `<UpgradeDialog />` inside `ShellCtx.Provider` in BOTH returns (the `bare` early return and the full shell), directly before the closing provider tag. The dialog renders null while closed, so this costs nothing.

- [ ] **Step 5: Verify** — `corepack pnpm --filter @derive/web test` (unit suites stay green) and the web typecheck (same command as Task 5 Step 6). Then run the web build to catch JSX/type slips: `corepack pnpm --filter @derive/web build`.
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): the upgrade dialog, one paywall surface for every billing block"
```

---

### Task 7: blocked banner

**Files:**
- Create: `apps/web/src/components/billing/blocked-banner.tsx`
- Modify: `apps/web/src/components/chrome/app-shell.tsx`

**Interfaces:**
- Consumes: `billingQuery` (with `blocked` from Task 5's type), router pathname (already read in AppShell).
- Produces: `<BlockedBanner />` rendered above page content whenever the workspace is blocked.

- [ ] **Step 1: The component.** Create `apps/web/src/components/billing/blocked-banner.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useAuth } from "@/ctx"
import { billingQuery } from "@/lib/queries"

// Copy by verdict code. The server's message names the URL for agents; humans
// get the short version with the button.
const COPY: Record<string, string> = {
  billing_required: "Publishing paused. Upgrade to Team to add more editors.",
  billing_lapsed: "Publishing paused. Renew your plan to resume publishing.",
}

// The workspace-is-blocked strip: non-dismissable by design (the state, not the
// notice, is the problem; it clears the moment the plan does). Null during beta
// grace and for healthy workspaces because `blocked` is server-computed and null.
// Hidden on the billing page itself, where the full comparison already is.
export function BlockedBanner({ pathname }: { pathname: string }) {
  const { me } = useAuth()
  const { data: billing } = useQuery({ ...billingQuery(), enabled: !!me })
  const blocked = billing?.blocked
  if (!blocked || pathname === "/settings/billing") return null
  return (
    <div
      data-testid="blocked-banner"
      role="status"
      className="flex shrink-0 items-center justify-between gap-3 bg-amber-500/10 px-4 py-2 text-sm text-foreground ring-1 ring-inset ring-amber-500/25"
    >
      <span>{COPY[blocked.code] ?? blocked.message}</span>
      <Link
        to="/settings/$section"
        params={{ section: "billing" }}
        data-testid="blocked-banner-see-plans"
        className="shrink-0 font-medium underline underline-offset-2 hover:text-foreground"
      >
        See plans
      </Link>
    </div>
  )
}
```

- [ ] **Step 2: Mount.** In `app-shell.tsx`'s full-shell return, render `<BlockedBanner pathname={pathname} />` inside `<SidebarInset>` as its FIRST child (above the mobile top bar and `{children}`), so it spans the page region on every route. Do not add it to the `bare` return: anonymous public views have no workspace to be blocked.

- [ ] **Step 3: Verify** — web typecheck + build (same commands as Task 6 Step 5).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/billing/blocked-banner.tsx apps/web/src/components/chrome/app-shell.tsx
git commit -m "feat(web): non-dismissable publishing-paused banner while blocked"
```

---

### Task 8: billing page redesign

**Files:**
- Modify: `apps/web/src/pages/settings/billing-section.tsx` (substantial rework; keep the file, keep everything that already works)

**Interfaces:**
- Consumes: `PLANS` (Task 6), `gb` (Task 6), existing `billingQuery`, `workspaceQuery`, `api.startCheckout`, `api.openBillingPortal`, `StatusPanel`, `ToggleGroup`.
- Produces: the shipped page. KEEP these behaviors and testids intact: `?checkout=success` consume/strip + `billing-success-banner` + the 2s/30s webhook poll; `billing-portal`; `billing-interval-toggle` (+ its `-month`/`-year` items); `billing-upgrade-team` / `billing-upgrade-business`; `billing-retry`; the beta note sentence; the non-admin caption "Only a workspace Admin can change billing."; the status/seat line logic (`statusLine`, `seatLine`, `LAPSED_STATUSES`, `FREE_SEAT_LIMIT` display constants).

Structure of the reworked render, top to bottom inside the existing `SettingsSection`:

1. success banner (unchanged)
2. `<CurrentPlanCard billing={billing} />` — the existing PlanCard, plus the storage meter replacing the plain storage line
3. interval `ToggleGroup` (the existing one, lifted out of `Upgrade` so its state drives the grid)
4. `<PlanGrid billing={billing} cycle={cycle} isAdmin={isAdmin} />`
5. subscribed && isAdmin: the existing `ManageBilling` portal block; non-admin: the existing caption
6. the Enterprise line

- [ ] **Step 1: Storage meter inside CurrentPlanCard.** Replace the `<p>{storageLine(billing)}</p>` line with:

```tsx
        <StorageMeter storage={billing.storage} tier={billing.tier} />
```

and add the component in the same file:

```tsx
// The one usage visual on the page: a quiet bar that turns amber at 80% so the
// nudge lands before the 413 does. Unlimited caps (self-host) keep the plain line.
function StorageMeter({
  storage,
  tier,
}: {
  storage: BillingInfo["storage"]
  tier: BillingInfo["tier"]
}) {
  if (storage.cap_bytes == null)
    return <p>{gb(storage.used_bytes)} used</p>
  const pct = Math.min(100, (storage.used_bytes / storage.cap_bytes) * 100)
  const high = pct >= 80
  return (
    <div data-testid="billing-storage-meter" className="flex flex-col gap-1">
      <p>
        {gb(storage.used_bytes)} used of {gb(storage.cap_bytes)}
      </p>
      <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-secondary">
        <div
          className={high ? "h-full rounded-full bg-amber-500" : "h-full rounded-full bg-primary"}
          style={{ width: `${pct}%` }}
        />
      </div>
      {high && tier === "free" && (
        <p className="text-amber-600 dark:text-amber-500">
          Running low? Team includes 50 GB pooled storage.
        </p>
      )}
    </div>
  )
}
```

- [ ] **Step 2: The grid.** Replace the `Upgrade` component's two-button block with the card grid (the interval toggle moves up to the section body; `cycle` state lives in `BillingSection` now):

```tsx
// The comparison surface: the pricing page's tier cards, in-app, with live
// current-plan context. Checkout buttons render only for admins of unsubscribed
// workspaces; a subscribed workspace changes plans in the Stripe portal below.
function PlanGrid({
  billing,
  cycle,
  isAdmin,
  onCheckout,
  pendingTier,
}: {
  billing: BillingInfo
  cycle: "month" | "year"
  isAdmin: boolean
  onCheckout: (tier: "team" | "business") => void
  pendingTier: (tier: string) => boolean
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {PLANS.map((p) => {
        const current = billing.tier === p.tier
        return (
          <div
            key={p.tier}
            data-testid={`billing-plan-card-${p.tier}`}
            className={
              p.tier === "team"
                ? "flex flex-col gap-3 rounded-xl bg-muted p-4 ring-2 ring-primary"
                : "flex flex-col gap-3 rounded-xl bg-muted p-4 ring-1 ring-border"
            }
          >
            <div className="flex items-center gap-2">
              <span className="text-base font-medium text-foreground">{p.name}</span>
              {"badge" in p && p.badge && (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                  {p.badge}
                </span>
              )}
              {current && (
                <span className="ml-auto rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  Current plan
                </span>
              )}
            </div>
            <p className="text-sm font-medium text-foreground">{p.price[cycle]}</p>
            <p className="text-sm text-muted-foreground">{p.tagline}</p>
            <ul className="flex flex-col gap-1.5 text-sm text-muted-foreground">
              {"everythingIn" in p && p.everythingIn && (
                <li className="font-medium text-foreground">{p.everythingIn}</li>
              )}
              {p.features.map((f) => (
                <li key={f} className="flex items-start gap-2">
                  <Icon name="check" size={14} className="mt-0.5 shrink-0 text-primary" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            {isAdmin && !billing.subscribed && p.tier !== "free" && (
              <Button
                data-testid={`billing-upgrade-${p.tier}`}
                size="sm"
                variant={p.tier === "team" ? "default" : "outline"}
                className="mt-auto"
                loading={pendingTier(p.tier)}
                onClick={() => onCheckout(p.tier as "team" | "business")}
              >
                {`Upgrade to ${p.name}`}
              </Button>
            )}
          </div>
        )
      })}
    </div>
  )
}
```

The checkout mutation stays exactly the existing one in `Upgrade` (mutationFn `api.startCheckout(tier, cycle)`, `pendingKey` by tier, redirect onSuccess); it moves up to `BillingSection` beside the new `cycle` state, and `PlanGrid` receives `onCheckout={(tier) => checkout.mutate({ tier, interval: cycle })}` and `pendingTier={(t) => checkout.isPendingFor(t)}`. Delete the old `Upgrade` component once the grid replaces it.

- [ ] **Step 3: The Enterprise line**, after the grid (and after ManageBilling/caption):

```tsx
      <p className="text-sm text-muted-foreground">
        Need isolation, residency, or procurement?{" "}
        <a className="underline underline-offset-2 hover:text-foreground" href="mailto:hello@derive.to">
          Talk to us
        </a>
        .
      </p>
```

- [ ] **Step 4: Wire it together.** `BillingSection` gains `const [cycle, setCycle] = useState<"month" | "year">("month")` and renders, in order: success banner, CurrentPlanCard, the ToggleGroup (existing markup with its testids, now bound to this `cycle`), PlanGrid, then `isAdmin && billing.subscribed ? <ManageBilling /> : null`, the non-admin caption where it is today, and the Enterprise line. The interval toggle renders for everyone (it flips the displayed card prices, which non-admins may want to see); checkout buttons stay admin-only via PlanGrid's guard.

- [ ] **Step 5: Verify** — web unit tests + typecheck + build (Task 6 Step 5 commands).
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/settings/billing-section.tsx
git commit -m "feat(web): the billing page becomes a real plan comparison"
```

---

### Task 9: Members seat note

**Files:**
- Modify: `apps/web/src/pages/settings/members-section.tsx`

**Interfaces:**
- Consumes: `billingQuery` (with `beta`, `tier`, `subscribed`, `seats`), the section's existing `addRole` state (the invite-role select), `FREE_SEAT_LIMIT` display constant idiom.

- [ ] **Step 1: The note.** In `members-section.tsx`, read billing (`const { data: billing } = useQuery(billingQuery())`) and render under the invite row (directly after the input/select/Add-button flex row), gated exactly as the spec says:

```tsx
      {billing &&
        billing.tier === "free" &&
        !billing.subscribed &&
        billing.seats >= 3 &&
        (addRole === "editor" || addRole === "owner") && (
          <p data-testid="members-seat-warning" className="text-sm text-muted-foreground">
            {billing.beta
              ? "Adding a 4th editor will require the Team plan once billing starts, $15 per editor for everyone. "
              : "Free covers 3 editor seats. Upgrading to Team adds unlimited editors, $15 per editor for everyone. "}
            <Link
              to="/settings/$section"
              params={{ section: "billing" }}
              className="underline underline-offset-2 hover:text-foreground"
            >
              See plans
            </Link>
          </p>
        )}
```

(`3` mirrors `FREE_SEAT_LIMIT` in `packages/core/src/billing.ts`; add the same mirror comment style used in billing-section.tsx. Import `Link` from `@tanstack/react-router` and `billingQuery` from `@/lib/queries`.)

- [ ] **Step 2: Verify** — web typecheck + build.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/settings/members-section.tsx
git commit -m "feat(web): members warns before the 4th editor seat"
```

---

### Task 10: full gates

**Files:** none new. This is the whole-branch verification.

- [ ] **Step 1:** `corepack pnpm run ci` from the repo root. Fix anything it flags (biome format, knip dead exports, lint:api, lint:testids, check-api-types).
- [ ] **Step 2:** `corepack pnpm run typecheck` (root script).
- [ ] **Step 3:** `corepack pnpm run test:coverage` (root). If ONLY `apps/api/test/mcp.test.ts` fails, rerun it in isolation (`corepack pnpm --filter @derive/api test mcp.test.ts`); green in isolation = the known flake, proceed.
- [ ] **Step 4:** Commit any gate fixes:

```bash
git add -A
git commit -m "chore: gate fixes for the upgrade-cta branch"
```

---

## Copy reference (verbatim, for reviewers)

- needs_team: "This workspace has more than 3 editor seats, so publishing is paused until it upgrades to the Team plan. An owner can upgrade at {billingUrl}."
- lapsed: "This workspace's plan has lapsed, so publishing is paused. Nothing was deleted. An owner can renew at {billingUrl}."
- seat_limit: "Free covers 3 editor seats, so this workspace needs the Team plan to add more editors. An owner can upgrade at {billingUrl}."
- storage: "This workspace is out of storage, so this save was refused. Upgrade for more at {billingUrl}."
- Banner needs_team: "Publishing paused. Upgrade to Team to add more editors." / lapsed: "Publishing paused. Renew your plan to resume publishing." / action: "See plans"
- Dialog seats: "Your team outgrew Free" / "You have {n} editor seats. Free covers 3." · lapsed: "Your plan has lapsed" / "Nothing was deleted. Renew to resume publishing." · storage: "You've hit your storage limit" / "{used} of {cap} used. Team includes 50 GB pooled storage." · non-owner: "Ask a workspace admin to upgrade." · link: "Compare all plans"
- Members beta: "Adding a 4th editor will require the Team plan once billing starts, $15 per editor for everyone. See plans" · enforced: "Free covers 3 editor seats. Upgrading to Team adds unlimited editors, $15 per editor for everyone. See plans"
- Storage nudge: "Running low? Team includes 50 GB pooled storage."
- Enterprise: "Need isolation, residency, or procurement? Talk to us."
