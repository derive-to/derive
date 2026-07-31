import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { api } from "@/api"
import { PlanFeatures } from "@/components/billing/plan-features"
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
import { type PaidTier, PLANS, type Plan } from "@/pages/settings/billing-plans"

// One dialog for every paywall hit, opened by the global mutation-error funnel
// (query-client.ts). The reason decides the headline; the sell is Team and
// Business side by side (mirrors billing-section.tsx's PlanGrid card look via
// the shared PlanFeatures component) so the step-up to Business is visible from
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

  const checkout = useApiMutation<{ url: string }, { tier: PaidTier; interval: "month" | "year" }>({
    mutationFn: ({ tier, interval }) => api.startCheckout(tier, interval),
    pendingKey: (vars) => vars.tier,
    onSuccess: ({ url }) => {
      window.location.href = url
    },
  })

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
        <ToggleGroup
          type="single"
          value={cycle}
          onValueChange={(v) => v && setCycle(v as "month" | "year")}
          data-testid="paywall-interval-toggle"
          className="w-fit gap-[3px] rounded-lg bg-secondary p-[3px]"
        >
          <ToggleGroupItem
            value="month"
            className="rounded-md text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-(--shadow-sm)"
          >
            Monthly
          </ToggleGroupItem>
          <ToggleGroupItem
            value="year"
            className="rounded-md text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-(--shadow-sm)"
          >
            Annual
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="grid gap-3 sm:grid-cols-2">
          {CARD_PLANS.map((p) => (
            <div
              key={p.tier}
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
              </div>
              <p className="text-sm font-medium text-foreground">{p.price[cycle]}</p>
              <PlanFeatures plan={p} />
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
            </div>
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
