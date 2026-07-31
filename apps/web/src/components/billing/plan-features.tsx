import { Icon } from "@/components/icons"
import type { Plan } from "@/pages/settings/billing-plans"

// The check-icon feature list, shared by the billing page's PlanGrid
// (billing-section.tsx) and the upgrade dialog's plan cards so the two
// surfaces can't drift on markup.
export function PlanFeatures({ plan }: { plan: Plan }) {
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
