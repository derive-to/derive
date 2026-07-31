import type { Role } from "@/api"

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
    // Numeric mirrors of the display `price` strings above: the same per-editor
    // monthly figures, as plain numbers, matching the Stripe lookup-key prices
    // seeded by the billing rail. `year` is the annually-billed MONTHLY rate, not
    // the yearly total.
    unit: { month: 15, year: 12 },
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
    // Numeric mirror of the display `price` strings above, same reasoning as
    // Team's `unit` field.
    unit: { month: 30, year: 25 },
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

/** The per-editor monthly price (whole dollars) for a tier at a billing
 *  interval: the numeric counterpart to the `unit` fields above, looked up in
 *  one place so the seat confirmation dialog (members-section.tsx) and the
 *  billing page's cost line (billing-section.tsx) can't compute it
 *  differently. Takes the full `BillingInfo["tier"]` union (not just
 *  `PaidTier`) so callers can pass it straight through with no cast; Free
 *  (which has no `unit`) and a `null`/`undefined` interval (never billed yet,
 *  treated as monthly) both resolve to 0. */
export const unitPrice = (
  tier: "free" | PaidTier,
  interval: "month" | "year" | null | undefined,
): number => {
  const plan = PLANS.find((p) => p.tier === tier)
  return plan && "unit" in plan ? plan.unit[interval ?? "month"] : 0
}

// Billable roles (mirror the pricing page + billing rail): Creator (editor) and
// Admin (owner) hold a seat; Viewer (commenter/legacy viewer) doesn't.
const isBillableRole = (r: Role): boolean => r === "editor" || r === "owner"

/** The paid-seat gate: true iff granting `newRole` on a subscribed workspace
 *  adds a NEW billed seat. The workspace bills per editor, so this covers both
 *  call sites in members-section.tsx — a fresh invite as Creator/Admin (no
 *  `existingRole`: the invitee isn't in the workspace yet) and a promotion of an
 *  existing commenter/viewer to editor/owner. Re-roles between the two billable
 *  roles (editor <-> owner) and any demotion carry no seat impact, so both
 *  return false. Unsubscribed or unknown billing (`undefined`) always returns
 *  false — that path keeps its existing free-tier note + server gate. */
export function needsSeatConfirm(
  billing: { subscribed: boolean } | undefined,
  newRole: Role,
  existingRole?: Role | null,
): boolean {
  const existingIsBillable = existingRole != null && isBillableRole(existingRole)
  return !!billing?.subscribed && isBillableRole(newRole) && !existingIsBillable
}
