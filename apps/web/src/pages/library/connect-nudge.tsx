import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { Icon } from "@/components/icons"
import { ConnectAgent } from "@/components/shared/connect-agent"
import { AskChip, EXAMPLE_ASKS } from "@/components/shared/example-asks"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/ctx"
import { connectedAgentsQuery, onboardingQuery } from "@/lib/queries"
import { STORAGE_KEYS } from "@/lib/storage-keys"
import { useDeferredGate } from "@/lib/use-deferred-gate"

// Whether the home's connect-your-agent card should render for this user right now.
// Shared with the library so the Brandprint nudge can yield (one onboarding surface
// per screen): while the user hasn't activated, connecting comes first. Ambient by
// design — errors and missing data just hide the card.
export function useConnectNudge() {
  const { me } = useAuth()
  const deferred = useDeferredGate()
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEYS.connectNudge) === "1"
    } catch {
      return true
    }
  })
  // Same read the rail pill uses (react-query dedupes them). Focus refetch matters:
  // the connect happens in the user's terminal — tabbing back is the moment to look.
  const { data: ob } = useQuery({
    ...onboardingQuery(),
    enabled: !!me && !dismissed && deferred,
    refetchOnWindowFocus: true,
  })
  const { data: agents } = useQuery({
    ...connectedAgentsQuery(),
    enabled: !!me && !dismissed && deferred,
    refetchOnWindowFocus: true,
  })
  const dismiss = () => {
    setDismissed(true)
    try {
      localStorage.setItem(STORAGE_KEYS.connectNudge, "1")
    } catch {
      /* private mode — the in-memory dismissal holds this session */
    }
  }
  const agentName = agents?.[0]?.clientName ?? ob?.agent_name ?? null
  const stage: "connect" | "publish" | null =
    !me || dismissed || !ob
      ? null
      : !ob.agent_connected
        ? "connect"
        : ob.published_via_agent
          ? null
          : "publish"
  return { stage, agentName, dismiss }
}

/**
 * The home library's activation card — the core loop, on the page people actually
 * land on. Two live stages, the same signals as /welcome and the rail pill:
 * no agent yet → the per-agent connect tabs; connected but never published → the
 * example first asks. Disappears on activation; "Not now" dismisses per-browser
 * (the rail pill and ⌘K stay as the quiet paths back). Sits above the publish
 * card and suppresses the Brandprint nudge while visible — one onboarding surface
 * per screen. The How-Derive-Works guide below is untouched: this card is the
 * door into the loop, that section explains it.
 */
export function ConnectNudge({ nudge }: { nudge: ReturnType<typeof useConnectNudge> }) {
  const { stage, agentName, dismiss } = nudge
  if (!stage) return null
  return (
    <section
      data-testid="library-connect-nudge"
      className="mb-6 flex flex-col gap-3 rounded-lg border bg-card px-5 py-4 shadow-xs"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          {stage === "connect" ? (
            <>
              <h2 className="font-serif text-lg font-medium tracking-tight text-foreground">
                Connect your agent.
              </h2>
              <p className="text-sm text-pretty text-muted-foreground">
                Derive works through the agent you already use — it publishes here, you share the
                link.
              </p>
            </>
          ) : (
            <>
              <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Icon name="check" className="text-success" />
                {agentName ?? "Agent"} connected
              </p>
              <h2 className="font-serif text-lg font-medium tracking-tight text-foreground">
                Now ask it to publish something.
              </h2>
            </>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          data-testid="library-connect-nudge-dismiss"
          className="text-muted-foreground"
          onClick={dismiss}
        >
          Not now
        </Button>
      </div>
      {stage === "connect" ? (
        <ConnectAgent testidPrefix="home-connect" />
      ) : (
        <div className="flex flex-col gap-2">
          {EXAMPLE_ASKS.map((ask, i) => (
            <AskChip key={ask} text={ask} testId={`library-ask-${i}`} />
          ))}
        </div>
      )}
    </section>
  )
}
