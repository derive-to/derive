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
