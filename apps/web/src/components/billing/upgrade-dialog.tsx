import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { BillingCycleToggle } from "@/components/billing/billing-cycle-toggle"
import { PlanCard } from "@/components/billing/plan-card"
import { useCheckout } from "@/components/billing/use-checkout"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { gb } from "@/lib/bytes"
import { closePaywall, type PaywallReason, usePaywall } from "@/lib/paywall"
import { billingQuery, workspaceQuery } from "@/lib/queries"
import { type PaidTier, PLANS, type Plan } from "@/pages/settings/billing-plans"

// One dialog for every paywall hit, opened by the global mutation-error funnel
// (query-client.ts). The reason decides the headline; the sell is Team and
// Business side by side (mirrors billing-section.tsx's PlanGrid card look via
// the shared PlanCard component) so the step-up to Business is visible from
// the first block, not an afterthought. Owners check out right here; everyone
// else learns who can.
export function UpgradeDialog() {
  const reason = usePaywall()
  return reason ? <UpgradeDialogBody reason={reason} /> : null
}

// The two paid tiers, in card order (Team first, Business on the right anchors
// the higher price).
const CARD_PLANS: Plan[] = PLANS.filter((p) => p.tier !== "free")

// Split so the data queries mount only while the dialog is open.
function UpgradeDialogBody({ reason }: { reason: PaywallReason }) {
  const { data: billing } = useQuery(billingQuery())
  const { data: ws, isError: wsError } = useQuery(workspaceQuery())
  const [cycle, setCycle] = useState<"month" | "year">("month")
  const isAdmin = ws?.role === "owner"
  const admins = (ws?.members ?? [])
    .filter((m) => m.role === "owner")
    .map((m) => m.name ?? m.handle ?? "a workspace admin")

  const checkout = useCheckout()

  const heads: Record<PaywallReason, { title: string; sub: string }> = {
    seats: {
      title: "Your team outgrew Free",
      sub: billing
        ? `You have ${billing.seats} editor seats. Free covers 3.`
        : "Free covers 3 editor seats.",
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

  return (
    <Dialog open onOpenChange={(open) => !open && closePaywall()}>
      <DialogContent data-testid="paywall-dialog" className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{heads[reason].title}</DialogTitle>
          <DialogDescription>{heads[reason].sub}</DialogDescription>
        </DialogHeader>
        {/* Shown to everyone (not gated on `ws`): the prices it drives on the cards
            below flip for admins and non-admins alike; only the buttons/AskAdmin
            footer needs the workspace role. */}
        <BillingCycleToggle
          value={cycle}
          onChange={setCycle}
          testIdPrefix="paywall-interval-toggle"
        />
        <div className="grid gap-3 sm:grid-cols-2">
          {CARD_PLANS.map((p) => (
            <PlanCard key={p.tier} plan={p} cycle={cycle}>
              {/* Wait for ws to load before showing a checkout button, avoiding a flash of
                  a button a non-admin can't use: see the AskAdmin gating below for the
                  matching wsError fallback. */}
              {ws && isAdmin && (
                <Button
                  data-testid={`paywall-checkout-${p.tier}`}
                  size="sm"
                  variant={p.tier === "team" ? "default" : "outline"}
                  className="mt-auto"
                  loading={checkout.isPendingFor(p.tier)}
                  disabled={checkout.isPending}
                  onClick={() => checkout.mutate({ tier: p.tier as PaidTier, interval: cycle })}
                >
                  {`Upgrade to ${p.name}`}
                </Button>
              )}
            </PlanCard>
          ))}
        </div>
        {/* Wait for ws to load before picking the role-dependent branch, avoiding a flash of
            wrong text — but if the query ERRORS (anonymous viewer, 401) `ws` never arrives, so
            fall back to the ask-an-admin copy without names rather than leaving the footer
            permanently empty. Admins already have their checkout buttons in the cards above,
            so this footer is non-admin only. */}
        {ws ? !isAdmin && <AskAdmin admins={admins} /> : wsError ? <AskAdmin /> : null}
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

// The non-owner footer, shared by the loaded-workspace branch (names the admins) and the
// query-error fallback (roster unknown, so the copy alone still tells the reader what to do).
function AskAdmin({ admins }: { admins?: string[] }) {
  return (
    <p className="text-sm text-muted-foreground">
      Ask a workspace admin to upgrade.
      {admins && admins.length > 0 && ` That's ${admins.join(", ")}.`}
    </p>
  )
}
