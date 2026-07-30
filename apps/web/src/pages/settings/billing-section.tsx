import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { api, type BillingInfo } from "@/api"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { billingQuery, workspaceQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
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

// bytes → "1.2 GB", the brief's fallback formula. No byte-format helper exists yet
// in lib/ (checked: no formatBytes/formatSize anywhere in apps/web/src), so this is
// the one place it's spelled out; a future shared helper should replace it here too.
const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`

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
      return "Canceled. Publishing is paused until an owner renews."
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

const storageLine = (b: BillingInfo): string => {
  const used = gb(b.storage.used_bytes)
  return b.storage.cap_bytes == null ? `${used} used` : `${used} used of ${gb(b.storage.cap_bytes)}`
}

// How long a just-completed checkout keeps re-polling for the webhook to land
// before giving up — Stripe's webhook is usually instant, but this covers the
// tail. Same idea as welcome.tsx's WATCH_INTERVAL_MS.
const CHECKOUT_POLL_INTERVAL_MS = 2000
const CHECKOUT_POLL_TIMEOUT_MS = 30_000

// Plan truth, upgrade, and the Stripe portal handoff. Owners (isAdmin) see the
// buttons; every member sees the plan card. Structural skeleton borrowed from
// general-section.tsx (the isAdmin gate, useQuery/useApiMutation idioms).
export function BillingSection() {
  const qc = useQueryClient()
  const { data: ws } = useQuery(workspaceQuery())
  const [showSuccessBanner, setShowSuccessBanner] = useState(false)
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
          <PlanCard billing={billing} />
          {isAdmin ? (
            billing.subscribed ? (
              <ManageBilling />
            ) : (
              <Upgrade />
            )
          ) : (
            <p className="text-sm text-muted-foreground">
              Only a workspace Admin can change billing.
            </p>
          )}
        </>
      ) : null}
    </SettingsSection>
  )
}

function PlanCard({ billing }: { billing: BillingInfo }) {
  const status = statusLine(billing)
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-muted p-4 ring-1 ring-border">
      <div className="text-base font-medium text-foreground">{TIER_LABELS[billing.tier]}</div>
      <div className="flex flex-col gap-0.5 text-sm text-muted-foreground">
        {status && <p>{status}</p>}
        <p>{seatLine(billing)}</p>
        <p>{storageLine(billing)}</p>
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

// The unsubscribed path: pick a billing cycle, then a tier — each starts a Stripe
// Checkout session and redirects there.
function Upgrade() {
  const [cycle, setCycle] = useState<"month" | "year">("month")
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
  const start = (tier: "team" | "business") => checkout.mutate({ tier, interval: cycle })

  const teamPrice = cycle === "year" ? "$12 per editor, billed annually" : "$15 per editor monthly"
  const businessPrice =
    cycle === "year" ? "$25 per editor, billed annually" : "$30 per editor monthly"

  return (
    <div className="flex flex-col items-start gap-3">
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
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="billing-upgrade-team"
          size="sm"
          loading={checkout.isPendingFor("team")}
          disabled={checkout.isPending}
          onClick={() => start("team")}
        >
          {`Upgrade to Team, ${teamPrice}`}
        </Button>
        <Button
          data-testid="billing-upgrade-business"
          variant="outline"
          size="sm"
          loading={checkout.isPendingFor("business")}
          disabled={checkout.isPending}
          onClick={() => start("business")}
        >
          {`Upgrade to Business, ${businessPrice}`}
        </Button>
      </div>
    </div>
  )
}
