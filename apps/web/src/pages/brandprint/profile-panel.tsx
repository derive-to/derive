import { queryOptions, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { API_BASE, ApiError, api, type DirUser } from "@/api"
import { ConnectAgentButton, PromptBlock, publicUrl } from "@/components/shared/connect-agent"
import { SectionTitle } from "@/components/shared/section-title"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "@/components/ui/sonner"
import { artifactAgentsQuery, artifactQuery, workspaceQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { AgentMenu, ALREADY_QUEUED, queuedFor } from "../artifact/ask-agent"
import { refFor } from "../artifact/parse-ref"
import type { AgentTarget } from "../artifact/types"

/**
 * The workspace brand profile's home on /brandprint. Renders the panel's two states:
 * - hand-off: sources saved, profile still the stub — the copyable brief. Doubles as
 *   the spec's no-agent state; ConnectAgent rides the card.
 * - live: the agent published the profile (a review round opened for you on the
 *   artifact page); Regenerate re-surfaces the brief.
 * The page owns the remaining spec states: "empty" is the section's create flow, and
 * without a profileId it mounts ApplyNudge instead of this panel.
 */
export function ProfilePanel({ profileId }: { profileId: string }) {
  const { data: art, isError: artError } = useQuery({
    ...artifactQuery(profileId),
    // Poll only while we wait on the agent: the publish bumps current_version, which
    // IS the reveal now. Once live the interval stands down.
    refetchInterval: (q) => ((q.state.data?.current_version ?? 0) >= 2 ? false : 5000),
  })
  // Client mirror of packages/core/src/brandprint.ts profileState — v1 is always the
  // intake's stub (the SPA deliberately doesn't import @derive/core).
  const live = (art?.current_version ?? 0) >= 2
  const [showBrief, setShowBrief] = useState(false)

  // An unreadable profile artifact degrades to nothing rather than a broken band —
  // the section below still renders and the docs stay manageable.
  if (artError) return null
  if (!art)
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-44" />
        <Skeleton className="h-40 w-full" />
      </div>
    )

  if (live && !showBrief)
    return (
      <section className="flex flex-col gap-3" data-testid="brandprint-profile-live">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <SectionTitle as="h2">Brand profile</SectionTitle>
            <p className="text-sm text-muted-foreground">
              Live. Every agent connected to this workspace reads it before authoring. An agent's
              change to it always opens a review round for you on the document.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild data-testid="brandprint-profile-open">
              <Link to="/artifacts/$ref" params={{ ref: refFor(art) }}>
                Open
              </Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-testid="brandprint-profile-regenerate"
              onClick={() => setShowBrief(true)}
            >
              Regenerate
            </Button>
          </div>
        </div>
        <ProfileFrame
          title="Brand profile"
          src={`${API_BASE}/raw/${profileId}/v/${art.current_version}/index.html`}
        />
      </section>
    )

  // Regenerating a live profile is the same card with an exit; first-time hand-off
  // has nothing to go back to.
  return (
    <HandoffCard profileId={profileId} onDismiss={live ? () => setShowBrief(false) : undefined} />
  )
}

// The brief stays three lines on purpose: connection, reads, output. All the heavy
// instruction lives in derive://brandprint/reference, so it improves server-side
// without anyone re-copying anything.
const briefFor = (url: string, profileId: string) =>
  `Finish setting up our Brandprint in Derive.
1. Connect to Derive over MCP if you aren't already: claude mcp add --transport http derive ${url}/mcp
2. Read derive://brandprint/reference and derive://brandprint/template, then our source docs (the other derive://brandprint/* resources).
3. Build our brand profile as ONE self-contained HTML file following the reference, and publish it with request_review: true to artifact ${profileId}.`

// The hand-off card: the spec's state 2 (and state 5, where Connect leads because no
// agent was ever authorized — ConnectAgentButton is one tap away either way). With a
// registered agent, one click queues the build brief straight into its pull inbox and
// the card flips to the queued state; the copyable brief stays as the fallback for
// agents that aren't registered here. Persistent and calm; the MCP never pitches, this
// card is the human-facing backstop. `onDismiss` present means a live profile exists
// and this is a regenerate.
function HandoffCard({ profileId, onDismiss }: { profileId: string; onDismiss?: () => void }) {
  const regenerating = !!onDismiss
  // Queued is session-local by design: a reload re-offers the button, and the server's
  // alreadyQueued dedupe both blocks a duplicate and flips this card straight back to
  // the queued state. The artifact poll above flips to live when the build lands.
  const [queued, setQueued] = useState(false)
  const { data: agents = [] } = useQuery(artifactAgentsQuery(profileId))
  const send = useApiMutation<{ requestId: string }, AgentTarget>({
    mutationFn: (agent) => api.generateProfile(profileId, agent.id),
    success: (_r, agent) => queuedFor("Build request", agent.name),
    errorToast: false,
    onError: (err) => {
      const code = err instanceof ApiError ? err.code : undefined
      // The queue already holds this ask — that IS the state this card wanted to show.
      if (code === "alreadyQueued") {
        setQueued(true)
        toast(ALREADY_QUEUED)
      } else toast.error("Couldn't queue the build. Copy the brief below instead.")
    },
    onSuccess: () => setQueued(true),
  })

  if (queued)
    return (
      <section
        className="flex flex-col gap-1 rounded-lg border bg-secondary/40 px-4 py-3"
        data-testid="brandprint-generate-queued"
      >
        <SectionTitle as="h2">Your agent is building your Brandprint</SectionTitle>
        <p className="text-sm text-pretty text-muted-foreground">
          The build brief is queued. The built profile will appear here after your agent's next
          session. You can leave this page open or come back later.
        </p>
      </section>
    )

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border bg-secondary/40 px-4 py-3"
      data-testid="brandprint-handoff"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <SectionTitle as="h2">
            {regenerating ? "Regenerate your brand profile" : "Finish with your agent"}
          </SectionTitle>
          <p className="text-sm text-pretty text-muted-foreground">
            {regenerating
              ? "Give your agent the brief again to rebuild the profile from the current sources. The new version will appear here for review."
              : "Your sources are saved and already guide connected agents. Give this brief to your agent to build the brand profile and publish it here for review."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {onDismiss && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="brandprint-handoff-cancel"
              onClick={onDismiss}
            >
              Keep current
            </Button>
          )}
          <SendToAgent agents={agents} pending={send.isPending} onPick={(a) => send.mutate(a)} />
          <ConnectAgentButton variant="outline" size="sm" testId="brandprint-handoff-connect" />
        </div>
      </div>
      <PromptBlock
        text={briefFor(publicUrl(), profileId)}
        testid="brandprint-brief"
        copyLabel="Copy the brief"
      />
    </section>
  )
}

// The one-click hand-off: the build brief goes into a registered agent's pull inbox, no
// copy-paste. Without a registered agent this renders nothing and the copyable brief +
// ConnectAgentButton beside it remain the path — the same sole/picker grammar as the
// selection bar's Ask-an-agent, so the two can't drift.
function SendToAgent({
  agents,
  pending,
  onPick,
}: {
  agents: DirUser[]
  pending: boolean
  onPick: (agent: AgentTarget) => void
}) {
  return (
    <AgentMenu
      agents={agents}
      menuLabel="Send the build brief to"
      testidPrefix="brandprint-generate"
      align="end"
      onPick={onPick}
      trigger={({ sole, onClick }) => (
        <Button
          size="sm"
          data-testid="brandprint-generate"
          loading={pending}
          disabled={pending}
          onClick={onClick}
        >
          {sole ? `Send to ${sole.name.split(/\s+/)[0]}` : "Send to your agent"}
        </Button>
      )}
    />
  )
}

// The live profile preview — the sandboxed-iframe treatment at a fixed
// page-friendly height.
function ProfileFrame({ title, src }: { title: string; src: string }) {
  return (
    <div className="h-[480px] overflow-hidden rounded-lg border">
      <iframe
        data-testid="brandprint-profile-frame"
        title={title}
        src={src}
        sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
        className="size-full border-0 bg-white"
      />
    </div>
  )
}
