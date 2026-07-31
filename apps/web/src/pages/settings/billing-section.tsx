import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { api, type BillingInfo } from "@/api"
import { Icon } from "@/components/icons"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { gb } from "@/lib/bytes"
import { billingQuery, workspaceQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { PLANS } from "./billing-plans"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SettingsSection } from "./settings-section"

// A workspace on the free tier keeps this many editor seats before an upgrade is
// required — mirrors packages/core/src/billing.ts's FREE_SEAT_LIMIT. Not imported
// at runtime (web never imports @derive/core — see .dependency-cruiser.mjs), so
// the number is pinned here as a display-only constant.
const FREE_SEAT_LIMIT = 3

const TIER_LABELS: Record<BillingInfo["tier"], string> = {
  free: "Free",
  team: "Team",
  business: "Business",
}

// Mirrors LAPSED_SUBSCRIPTION_STATUSES in packages/core/src/billing.ts (not
// imported at runtime, same reasoning as FREE_SEAT_LIMIT above): a formerly-live
// subscription that ended, distinct from never having subscribed at all.
const LAPSED_STATUSES = new Set(["canceled", "unpaid", "incomplete_expired"])

const statusLine = (b: BillingInfo): string | null => {
  if (!b.subscribed) {
    // `tier` already reports the current entitlement ("free") once a subscription
    // lapses, so it can't distinguish "never subscribed" from "canceled" — only
    // the raw status can, so the message is derived from status alone.
    if (b.status && LAPSED_STATUSES.has(b.status))
      // Beta: nothing is actually paused yet, so don't claim it is. The beta note in
      // the plan card covers messaging.
      return b.beta ? "Canceled." : "Canceled. Publishing is paused until an owner renews."
    return null
  }
  if (b.status === "past_due") return "Payment past due, publishing continues while Stripe retries"
  if (b.current_period_end) return `Renews ${new Date(b.current_period_end).toLocaleDateString()}`
  return null
}

const seatLine = (b: BillingInfo): string => {
  if (b.tier === "free") return `${b.seats} of ${FREE_SEAT_LIMIT} free editor seats used`
  return `${b.seats} editor seat${b.seats === 1 ? "" : "s"}`
}

// How long a just-completed checkout keeps re-polling for the webhook to land
// before giving up — Stripe's webhook is usually instant, but this covers the
// tail. Same idea as welcome.tsx's WATCH_INTERVAL_MS.
const CHECKOUT_POLL_INTERVAL_MS = 2000
const CHECKOUT_POLL_TIMEOUT_MS = 30_000

// Plan truth, the storage meter, the tier comparison grid, and the Stripe portal
// handoff. Every member sees the plan card and grid; only admins (isAdmin) see
// checkout buttons and the portal link. Structural skeleton borrowed from
// general-section.tsx (the isAdmin gate, useQuery/useApiMutation idioms).
export function BillingSection() {
  const qc = useQueryClient()
  const { data: ws } = useQuery(workspaceQuery())
  const [showSuccessBanner, setShowSuccessBanner] = useState(false)
  const [cycle, setCycle] = useState<"month" | "year">("month")
  // A ref, not state: refetchInterval reads it synchronously on every tick, and
  // a ref's .current is always current there without re-subscribing the query.
  const pollDeadline = useRef<number | null>(null)

  // ?checkout=success lands here fresh back from Stripe: the cached billing
  // query may predate the webhook, so consume + strip the param (same one-shot
  // idiom as general-section's ?new-workspace=1), force a refetch, and poll
  // briefly until the webhook flips `subscribed` true.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.get("checkout") === "success") {
      url.searchParams.delete("checkout")
      window.history.replaceState(null, "", url)
      setShowSuccessBanner(true)
      pollDeadline.current = Date.now() + CHECKOUT_POLL_TIMEOUT_MS
      void qc.invalidateQueries({ queryKey: billingQuery().queryKey })
    }
  }, [qc])

  const {
    data: billing,
    isPending,
    isError,
    refetch,
  } = useQuery({
    ...billingQuery(),
    refetchInterval: (q) => {
      if (pollDeadline.current === null) return false
      if (q.state.data?.subscribed) return false
      if (Date.now() >= pollDeadline.current) return false
      return CHECKOUT_POLL_INTERVAL_MS
    },
  })
  const isAdmin = ws?.role === "owner"

  // The unsubscribed path: pick a billing cycle, then a tier — each starts a
  // Stripe Checkout session and redirects there. Lives here (not in PlanGrid) so
  // the same `cycle` state that drives the toggle also drives the grid's prices.
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

  return (
    <SettingsSection title="Billing" description="Your plan, seats, and storage.">
      {showSuccessBanner && (
        <div data-testid="billing-success-banner">
          <StatusPanel
            tone="success"
            layout="inline"
            title="Upgrade complete."
            description="Your plan is active as soon as Stripe confirms payment, usually within seconds."
          />
        </div>
      )}
      {isPending ? (
        <SettingsListSkeleton rows={1} trailing={false} />
      ) : isError ? (
        <StatusPanel
          tone="danger"
          title="Couldn't load billing"
          description="This is usually temporary."
          action={
            <Button
              variant="outline"
              size="sm"
              data-testid="billing-retry"
              onClick={() => refetch()}
            >
              Try again
            </Button>
          }
        />
      ) : billing ? (
        <>
          <CurrentPlanCard billing={billing} />
          <ToggleGroup
            type="single"
            value={cycle}
            onValueChange={(v) => v && setCycle(v as "month" | "year")}
            data-testid="billing-interval-toggle"
            className="gap-[3px] rounded-lg bg-secondary p-[3px]"
          >
            <ToggleGroupItem
              value="month"
              data-testid="billing-interval-toggle-month"
              className="rounded-md text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-(--shadow-sm)"
            >
              Monthly
            </ToggleGroupItem>
            <ToggleGroupItem
              value="year"
              data-testid="billing-interval-toggle-year"
              className="rounded-md text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-(--shadow-sm)"
            >
              Annual
            </ToggleGroupItem>
          </ToggleGroup>
          <PlanGrid
            billing={billing}
            cycle={cycle}
            isAdmin={isAdmin}
            onCheckout={(tier) => checkout.mutate({ tier, interval: cycle })}
            pendingTier={(t) => checkout.isPendingFor(t)}
            checkoutPending={checkout.isPending}
          />
          {isAdmin ? (
            billing.subscribed && <ManageBilling />
          ) : (
            <p className="text-sm text-muted-foreground">
              Only a workspace Admin can change billing.
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            Need isolation, residency, or procurement?{" "}
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href="mailto:hello@derive.to"
            >
              Talk to us
            </a>
            .
          </p>
        </>
      ) : null}
    </SettingsSection>
  )
}

function CurrentPlanCard({ billing }: { billing: BillingInfo }) {
  const status = statusLine(billing)
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-muted p-4 ring-1 ring-border">
      <div className="text-base font-medium text-foreground">{TIER_LABELS[billing.tier]}</div>
      <div className="flex flex-col gap-0.5 text-sm text-muted-foreground">
        {status && <p>{status}</p>}
        <p>{seatLine(billing)}</p>
        <StorageMeter storage={billing.storage} tier={billing.tier} />
      </div>
      {billing.beta && (
        <p className="text-sm text-muted-foreground">
          Free while we're in beta. Billing starts only with notice, and existing workspaces get a
          grace period.
        </p>
      )}
    </div>
  )
}

// The one usage visual on the page: a quiet bar that turns amber at 80% so the
// nudge lands before the 413 does. Unlimited caps (self-host) keep the plain line.
function StorageMeter({
  storage,
  tier,
}: {
  storage: BillingInfo["storage"]
  tier: BillingInfo["tier"]
}) {
  if (storage.cap_bytes == null) return <p>{gb(storage.used_bytes)} used</p>
  const pct = Math.min(100, (storage.used_bytes / storage.cap_bytes) * 100)
  const high = pct >= 80
  return (
    <div data-testid="billing-storage-meter" className="flex flex-col gap-1">
      <p>
        {gb(storage.used_bytes)} used of {gb(storage.cap_bytes)}
      </p>
      <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-secondary">
        <div
          className={
            high
              ? "h-full rounded-full bg-amber-500" /* tokens-ignore */
              : "h-full rounded-full bg-primary"
          }
          style={{ width: `${pct}%` }}
        />
      </div>
      {high && tier === "free" && (
        <p className="text-amber-600 dark:text-amber-500" /* tokens-ignore */>
          Running low? Team includes 50 GB pooled storage.
        </p>
      )}
    </div>
  )
}

// The comparison surface: the pricing page's tier cards, in-app, with live
// current-plan context. Checkout buttons render only for admins of unsubscribed
// workspaces; a subscribed workspace changes plans in the Stripe portal below.
function PlanGrid({
  billing,
  cycle,
  isAdmin,
  onCheckout,
  pendingTier,
  checkoutPending,
}: {
  billing: BillingInfo
  cycle: "month" | "year"
  isAdmin: boolean
  onCheckout: (tier: "team" | "business") => void
  pendingTier: (tier: string) => boolean
  /** True while ANY tier's checkout is in flight — disables every button so a click on
   *  Business while Team's session is still opening can't fire two Stripe sessions. */
  checkoutPending: boolean
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
                disabled={checkoutPending}
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

// The subscribed path: everything else (cards, invoices, plan swaps, cancellation)
// happens in Stripe's own hosted portal, not re-built here.
function ManageBilling() {
  const portal = useApiMutation({
    mutationFn: () => api.openBillingPortal(),
    onSuccess: ({ url }) => {
      window.location.href = url
    },
  })
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        data-testid="billing-portal"
        variant="outline"
        size="sm"
        loading={portal.isPending}
        disabled={portal.isPending}
        onClick={() => portal.mutate()}
      >
        Manage billing
      </Button>
      <p className="text-sm text-muted-foreground">
        Cards, invoices, plan changes, and cancellation happen in the Stripe portal.
      </p>
    </div>
  )
}
