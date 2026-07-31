import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useAuth } from "@/ctx"
import { useBootGate } from "@/lib/bootstrap"
import { blockedQuery } from "@/lib/queries"

// Copy by verdict code. The server's message names the URL for agents; humans
// get the short version with the button.
const COPY: Record<string, string> = {
  billing_required:
    "Your team has outgrown the Free plan, so publishing is paused. Upgrade to keep Deriving.",
  billing_lapsed: "Your plan has lapsed, so publishing is paused. Renew to keep Deriving.",
}

// The workspace-is-blocked strip: non-dismissable by design (the state, not the
// notice, is the problem; it clears the moment the plan does). Null during beta
// grace and for healthy workspaces because `blocked` is server-computed and null.
// Hidden on the billing page itself, where the full comparison already is.
export function BlockedBanner({ pathname }: { pathname: string }) {
  const { me } = useAuth()
  // Boot-batch gated, like the rail's summary/collections: the verdict arrives with
  // /v1/bootstrap, so this normally issues no request. Only a failed batch opens the
  // gate onto the fallback endpoint.
  const bootGate = useBootGate()
  const { data: blocked } = useQuery({ ...blockedQuery(), enabled: !!me && bootGate })
  if (!blocked || pathname === "/settings/billing") return null
  return (
    <div
      data-testid="blocked-banner"
      role="status"
      className="flex shrink-0 items-center justify-between gap-3 bg-amber-500/10 px-4 py-2 text-sm text-foreground ring-1 ring-inset ring-amber-500/25" /* tokens-ignore */
    >
      <span>{COPY[blocked.code] ?? blocked.message}</span>
      <Link
        to="/settings/$section"
        params={{ section: "billing" }}
        data-testid="blocked-banner-see-plans"
        className="shrink-0 font-medium underline underline-offset-2 hover:text-foreground"
      >
        See plans
      </Link>
    </div>
  )
}
