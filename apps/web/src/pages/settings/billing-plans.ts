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
