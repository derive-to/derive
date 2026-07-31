# Upgrade-Path CTAs + Billing Page Breakdown: Design

Date: 2026-07-30. Follow-up to `2026-07-30-billing-rail-design.md` (the shipped billing rail on this branch). Two deliverables, one feature: (1) every paywall hit becomes an upgrade moment instead of an error toast, and (2) the billing settings page becomes a real plan-comparison surface with full per-tier feature breakdowns.

Decisions locked with Connor (2026-07-30):

- Global upgrade dialog on any billing block, PLUS a persistent, non-dismissable "publishing paused" banner while the workspace is blocked. The banner links straight to `/settings/billing` (one click from banner to the plan comparison).
- Tier feature lists mirror the published pricing page (`apps/web/public/site/pricing.html`) exactly, including not-yet-shipped Business items (SSO, audit log, guest management, SLA). One deliberate deviation: the storage overage clause ("~$1 per extra 10 GB/month") is omitted in-app because overage metering does not exist; cards say "50 GB pooled storage" / "250 GB pooled storage" plainly.
- Owners check out directly from the dialog (tier + interval, straight to Stripe Checkout). Non-owners see the benefits plus "Ask a workspace admin" with the actual admin names.
- Proactive touches in scope: storage nudge at 80% of cap, billing-page URL in agent/MCP error copy so a blocked publish tells the agent's human exactly where to upgrade.
- The 4th billable seat is BLOCKED at invite time once enforcement starts (decision 2026-07-30, superseding the earlier warn-only design): the invite returns the 402, the upgrade dialog opens, the owner can pay and re-send. During beta the invite goes through with a forward-looking note. Role promotions get the same gate (otherwise it is a trivial bypass). The publish gate + banner remain the backstop for workspaces already over the limit.

## Why now

The rail enforces; nothing sells. Today a blocked publish surfaces as a generic red toast carrying the server sentence, storage overflow says "storage quota exceeded", and the billing page is a plan card with two buttons and zero feature story. Pre-enforcement this is invisible; on enforcement day it becomes the difference between a conversion and a support ticket.

## 1. API changes (`apps/api`)

### 1a. `GET /v1/billing` gains `blocked`

New response field, server-computed so the web never re-implements the gate:

```
blocked: { code: "billing_required" | "billing_lapsed"; message: string } | null
```

Derived in `routes/billing.ts` from the `BillingState` the route already holds (`state.canPublishApprove` / `state.blockedReason`), zero extra queries. During beta grace it is always `null`, so all new blocked-state UI stays dormant until enforcement day by construction. Update the hand-declared `BillingInfo` type in `apps/web/src/api.ts` to match (this route is plain Hono, not OpenAPI-generated).

### 1b. Storage-overflow 413s carry a machine code

Every REST `fail(c, 413, "storage quota exceeded")` gains `{ code: "storage_exceeded" }` (and the new message text from 1c):

- `routes/artifacts.ts` (two sites, publish + version upload)
- `routes/assets.ts` (one site)
- `routes/proposals.ts` (two sites)

"upload too large" 413s stay code-less; the web must distinguish "buy more storage" from "file too big". MCP tool errors are text-only and unaffected by this code (they get the copy change below).

### 1c. Block copy carries the billing URL

`BILLING_BLOCK_COPY` messages end with the direct link, built from `deps.baseUrl` at context-construction time (the record becomes a computed value, not a static literal; `session-turn.ts`'s `apologyFor` keeps exact-matching because it reads the same built object):

- needs_team: "This workspace has more than 3 editor seats, so publishing is paused until it upgrades to the Team plan. An owner can upgrade at {baseUrl}/settings/billing."
- lapsed: "This workspace's plan has lapsed, so publishing is paused. Nothing was deleted. An owner can renew at {baseUrl}/settings/billing."

The MCP/REST storage-overflow message becomes: "This workspace is out of storage, so this save was refused. Upgrade for more at {baseUrl}/settings/billing." for the sites in 1b plus the storage checks in `mcp-tools/publish.ts` and `mcp-tools/checkpoint.ts`. Sync paths (`lib/sync.ts`, `lib/sync-runner.ts`) keep their current logging behavior.

This satisfies Connor's ask directly: an agent attempting a publish in a blocked workspace gets told publishing is paused until the workspace upgrades, with the billing page URL in hand.

### 1d. Seat gate on granting a billable role

Once enforcement is active, any request that would grant a 4th billable seat to a free, unsubscribed workspace is refused with 402 `{ code: "billing_required" }` and its own message (publishing copy would be wrong here):

- seat_limit: "Free covers 3 editor seats, so this workspace needs the Team plan to add more editors. An owner can upgrade at {baseUrl}/settings/billing."

Gate condition: enforcement active (same `DERIVE_BILLING_ENFORCE_AT` grace as every other gate; during beta the grant proceeds), no active subscription, current billable seat count >= 3, and the granted role is billable (editor or owner). Gated paths: the direct member invite endpoint (which the workspace-creation invite fan-out also flows through; verify at plan time) and the member role-change endpoint (Viewer promoted to Creator/Admin). Subscribed workspaces are never seat-gated: `syncSeats` already bills the new seat, which is the licensed-on-grant model working as designed. Invite ACCEPTANCE stays ungated (an invite sent pre-enforcement can still be accepted; the publish gate and banner are the backstop for the resulting over-limit state).

## 2. Web: paywall interception + upgrade dialog

### 2a. Interceptor

`lib/query-client.ts` already funnels every mutation error through `MutationCache.onError`. New pure function, exported and unit-tested beside `shouldToastError`:

```
paywallReasonFor(err: unknown): "seats" | "lapsed" | "storage" | null
```

Maps `ApiError.code`: `billing_required` to seats, `billing_lapsed` to lapsed, `storage_exceeded` to storage. When non-null, `onError` opens the paywall dialog and suppresses the toast; all other errors behave as today. `meta.errorToast: false` sites are unaffected (they never reached the global toast anyway; the dialog still opens for them on billing codes so no surface silently swallows a block).

### 2b. Paywall store

`lib/paywall.ts`: a dependency-free module store (`useSyncExternalStore`) holding `{ reason: "seats" | "lapsed" | "storage" } | null`, with `openPaywall(reason)` / `closePaywall()`. No zustand; matches the repo's no-new-deps posture.

### 2c. UpgradeDialog

`components/billing/upgrade-dialog.tsx`, mounted once in `components/chrome/app-shell.tsx`. Built on the existing shadcn `Dialog`. Reads `billingQuery` and `workspaceQuery`.

Reason-aware header (real numbers, no scolding):

- seats: title "Your team outgrew Free", sub "You have {seats} editor seats. Free covers 3."
- lapsed: title "Your plan has lapsed", sub "Nothing was deleted. Renew to resume publishing."
- storage: title "You've hit your storage limit", sub "{used} of {cap} used. Team includes 50 GB pooled storage."

Body: the Team feature list from the shared plans constant (section 4) with check icons, then the price line "$15 per editor monthly, or $12 billed annually" (interval-aware once toggled).

Footer, owner (`ws.role === "owner"`): Monthly/Annual toggle (same ToggleGroup styling as today's billing section), primary "Upgrade to Team", secondary "Upgrade to Business" (its price line beneath), both reusing `api.startCheckout` and redirecting to Stripe. A quiet "Compare all plans" link to `/settings/billing`.

Footer, non-owner: "Ask a workspace admin to upgrade." plus the admin names from the roster (`ws.members` where role is owner, rendered as names, comma-separated), and the same "Compare all plans" link.

Testids: `paywall-dialog`, `paywall-checkout-team`, `paywall-checkout-business`, `paywall-interval-toggle`, `paywall-see-plans`.

## 3. Blocked banner (non-dismissable)

Rendered by `app-shell.tsx` whenever `billing.blocked` is non-null, above the app content: a slim warning-tone strip, no dismiss control. Hidden on `/settings/billing` itself (redundant there). Copy by code:

- billing_required: "Publishing paused. Upgrade to Team to add more editors."
- billing_lapsed: "Publishing paused. Renew your plan to resume publishing."

Trailing action: "See plans" navigating to `/settings/billing`. Same banner for every member role (the billing page explains the admin-only part). Testid: `blocked-banner`, action `blocked-banner-see-plans`.

The app shell now subscribes to `billingQuery` for signed-in workspace sessions; it is one cached query (30s staleTime + IndexedDB persistence) and the same data the dialog needs anyway.

## 4. Billing page redesign (`/settings/billing`)

Everything shipped in the rail is kept: beta note, `?checkout=success` consume + webhook poll + success banner, Stripe portal for subscribed workspaces, admin gating, retry state.

New structure, top to bottom:

1. **Current-plan summary** (evolves the existing PlanCard): tier name, status line (renews/past-due/canceled logic unchanged), seats line, and a storage meter: a progress bar of `used_bytes / cap_bytes` that turns amber at 80%+ with the nudge line "Running low? Team includes 50 GB pooled storage." (nudge only on free tier; on paid tiers the amber bar stands alone). Unlimited cap renders the plain "X GB used" line as today.
2. **Interval toggle** (Monthly / Annual), shared state for cards and checkout, defaulting to monthly.
3. **Three tier cards** in a responsive grid (stack on narrow): Free, Team (visually accented, "Most teams" tag), Business. Each card: name, interval-aware price ("$0 forever" / "$15 per editor / month" or "$12 per editor / month, billed annually" / "$30" or "$25"), one-line tagline from the pricing page, feature list with check icons. Card footer: "Current plan" badge on the active tier; on the others, for admins of unsubscribed workspaces, the checkout button ("Upgrade to Team" / "Upgrade to Business"); for subscribed workspaces no per-card buttons (plan changes live in the portal; the existing "Manage billing" portal button renders below the grid); for non-admins no buttons (the existing "Only a workspace Admin can change billing." caption below the grid).
4. **Enterprise line** under the grid: "Need isolation, residency, or procurement? Talk to us." linking `mailto:hello@derive.to` (same target as the pricing page).

Feature lists live in `pages/settings/billing-plans.ts`, a display-only constant shared by the cards and the dialog so the two surfaces cannot drift. Contents mirror the pricing page verbatim:

- Free ("For individuals, open-source projects, and small teams"): Up to 3 editors per workspace; Unlimited viewers and commenters; The full review loop: comments, proposals, approvals; CLI, API, and MCP for your agents; Permanent URLs with full version history; 1 GB storage, deduplicated.
- Team ("For teams whose agents ship work that needs review"): Everything in Free, plus; Unlimited editors; Custom domain; White-label shared pages; Password-protected links; Brandprint: your house style, read by every agent; 50 GB pooled storage; Full analytics history.
- Business ("For organizations that need control and accountability"): Everything in Team, plus; 250 GB pooled storage; SSO with your identity provider (OIDC); Audit log; Multiple custom domains; Guest editor management; Uptime SLA; Priority support.

Testids: `billing-plan-card-free|team|business`, `billing-storage-meter`; existing testids (`billing-upgrade-team`, `billing-upgrade-business`, `billing-interval-toggle`, `billing-portal`, `billing-success-banner`) keep their names on the new layout so the e2e vocabulary survives.

## 5. Members: the 4th-editor moment

The server gate is section 1d; this section is the Members UX around it.

Inline note under the invite row when the workspace is free with no subscription (`billing.tier === "free" && !billing.subscribed`), the server-computed seat count is at the limit (`billing.seats >= 3`), and the invite-role selector is set to a billable role (Creator or Admin, i.e. editor/owner):

- During beta (`billing.beta`): "Adding a 4th editor will require the Team plan once billing starts, $15 per editor for everyone. See plans"
- Post-enforcement: "Free covers 3 editor seats. Upgrading to Team adds unlimited editors, $15 per editor for everyone. See plans"

with "See plans" linking `/settings/billing`. `billing.seats` is the source of truth (server-side billable count), never a client-side roster recount. Testid: `members-seat-warning`.

When the gate refuses the invite or promotion (402 from section 1d), no Members-specific handling is needed: the global interceptor opens the upgrade dialog with the seats reason. After a successful upgrade the admin re-sends the invite (no queued auto-retry; YAGNI).

## 6. Testing

API (`apps/api/test/`):

- `billing.test.ts`: `blocked` is null during beta grace, null while subscribed, `billing_required` with 4 seats past enforcement, `billing_lapsed` when canceled past enforcement; blocked message contains `/settings/billing`.
- Seat gate: during beta the 4th billable invite succeeds; post-enforcement it 402s with `billing_required` and the seat_limit message; a Viewer (commenter) invite always succeeds; a subscribed workspace's 4th editor invite succeeds; promoting a Viewer to Creator hits the same gate; accepting a pre-existing invite is not gated.
- Storage: over-cap publish asserts `body.code === "storage_exceeded"` (and the message contains the URL); an oversize upload keeps its code-less "upload too large".
- `billing-gate.test.ts` (MCP): blocked publish tool error text contains `/settings/billing`.

Web:

- `paywallReasonFor` unit tests beside the other pure query-client helpers (billing codes map, unknown codes and code-less errors return null).
- Existing web logic-test idiom only (no component test harness exists; do not introduce one).

Live verification (end of build, like the rail's E2E): Playwright pass over the redesigned billing page, the dialog (force a storage block or seat block in a dev workspace with enforcement env set), and the banner.

## 7. Global constraints

- No em dashes anywhere in user-facing copy; commas/colons/periods (en dashes allowed in numeric ranges).
- Web never imports `@derive/core` (dependency-cruiser rule): display constants stay pinned web-side with mirror comments, the established idiom in `billing-section.tsx`.
- `routes/billing.ts` stays plain Hono; `BillingInfo` stays hand-declared in `api.ts`.
- All commands via `corepack pnpm`; the full `pnpm run ci` + typecheck + coverage gates must pass (note: `test/mcp.test.ts` is flaky under full-suite coverage load, pre-existing on main, passes in isolation).
- Testids follow the repo's testid lint; new exports must survive knip.
- UI copy vocabulary: "editor seats" in billing copy (matches shipped billing section), role labels Admin/Creator/Viewer in Members UI.
- No new runtime dependencies.

## Out of scope

- Storage overage metering/billing (the "~$1 per 10 GB" pricing-page clause).
- Queued auto-retry of a refused invite after upgrade (admin re-sends by hand).
- Founding-member annual (GTM step 12).
- Marketing pricing page changes (it already matches; the FAQ's activity-based editor wording remains a pre-enforcement follow-up from the rail).
