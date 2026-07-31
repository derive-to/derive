import { api } from "@/api"
import { useApiMutation } from "@/lib/use-api-mutation"
import type { PaidTier } from "@/pages/settings/billing-plans"

/** Start a Stripe Checkout session for a tier + billing interval and redirect there —
 *  shared by the billing page's PlanGrid and the paywall's UpgradeDialog so the two
 *  can't drift. The redirect lives here, not at the call site: Checkout is a full-page
 *  handoff to Stripe's hosted form, not a modal, so there's no in-app state to return
 *  to on success (Stripe's own success_url brings the user back). */
export function useCheckout() {
  return useApiMutation<{ url: string }, { tier: PaidTier; interval: "month" | "year" }>({
    mutationFn: ({ tier, interval }) => api.startCheckout(tier, interval),
    pendingKey: (vars) => vars.tier,
    onSuccess: ({ url }) => {
      window.location.href = url
    },
  })
}
