import type { ReactNode } from "react"
import { Icon } from "@/components/icons"
import type { Plan } from "@/pages/settings/billing-plans"

// The check-icon feature list. Lives here, not its own file, because PlanCard is
// its only caller: one renderer for tier features, shared by the billing page's
// PlanGrid and the paywall dialog's cards, so the two surfaces can't drift.
function PlanFeatures({ plan }: { plan: Plan }) {
  return (
    <ul className="flex flex-col gap-1.5 text-sm text-muted-foreground">
      {"everythingIn" in plan && plan.everythingIn && (
        <li className="font-medium text-foreground">{plan.everythingIn}</li>
      )}
      {plan.features.map((f) => (
        <li key={f} className="flex items-start gap-2">
          <Icon name="check" size={14} className="mt-0.5 shrink-0 text-primary" />
          <span>{f}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * The plan-card shell: tier name, the Team tier's accent ring, the interval price
 * line, and the feature list — the chrome the billing page's
 * PlanGrid and the paywall dialog's cards agree on exactly, so it's built once
 * here instead of hand-copied. `children` is the footer slot (the page's
 * conditional upgrade Button, the dialog's checkout Button, or nothing).
 */
export function PlanCard({
  plan,
  cycle,
  current,
  showTagline,
  testId,
  children,
}: {
  plan: Plan
  cycle: "month" | "year"
  /** Show the "Current plan" pill — the billing page's own tier only; the dialog
   *  sells plans with no notion of "current". */
  current?: boolean
  /** The billing page shows each plan's one-line pitch under the price; the
   *  dialog's more compact cards skip it. */
  showTagline?: boolean
  /** `billing-plan-card-{tier}` on the page; the dialog's cards pass none. */
  testId?: string
  children?: ReactNode
}) {
  return (
    <div
      data-testid={testId}
      className={
        plan.tier === "team"
          ? "flex flex-col gap-3 rounded-xl bg-muted p-4 ring-2 ring-primary"
          : "flex flex-col gap-3 rounded-xl bg-muted p-4 ring-1 ring-border"
      }
    >
      <div className="flex items-center gap-2">
        <span className="text-base font-medium text-foreground">{plan.name}</span>
        {current && (
          <span className="ml-auto rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-muted-foreground">
            Current plan
          </span>
        )}
      </div>
      <p className="text-sm font-medium text-foreground">{plan.price[cycle]}</p>
      {showTagline && <p className="text-sm text-muted-foreground">{plan.tagline}</p>}
      <PlanFeatures plan={plan} />
      {children}
    </div>
  )
}
