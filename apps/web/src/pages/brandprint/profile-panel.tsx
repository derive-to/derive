import { queryOptions, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { API_BASE, ApiError, api } from "@/api"
import { ConnectAgentButton, PromptBlock, publicUrl } from "@/components/shared/connect-agent"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "@/components/ui/sonner"
import { artifactAgentsQuery, artifactQuery, workspaceQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { usableAgents } from "../artifact/ask-agent"
import { refFor } from "../artifact/parse-ref"
import type { AgentTarget } from "../artifact/types"

/**
 * The workspace brand profile's home on /brandprint. Renders the panel's three states:
 * - hand-off: sources saved, profile still the stub, no proposal — the copyable brief.
 *   Doubles as the spec's no-agent state; ConnectAgent rides the card.
 * - reveal: the agent's proposal is in — full-width preview, Approve, comments.
 * - live: an approved profile fronts the page; Regenerate re-surfaces the brief.
 * The page owns the remaining spec states: "empty" is the section's create flow, and
 * without a profileId it mounts ApplyNudge instead of this panel.
 */
const profileProposalsQuery = (profileId: string) =>
  queryOptions({
    queryKey: ["brandprint-profile-proposals", profileId] as const,
    queryFn: () => api.listProposals(profileId, "open").then((r) => r.proposals),
  })

export function ProfilePanel({ profileId }: { profileId: string }) {
  const { data: ws } = useQuery(workspaceQuery())
  const { data: art, isError: artError } = useQuery(artifactQuery(profileId))
  // Client mirror of packages/core/src/brandprint.ts profileState — v1 is always the
  // intake's stub (the SPA deliberately doesn't import @derive/core).
  const live = (art?.current_version ?? 0) >= 2
  // Poll only while we actually wait on the agent: profile not live, no proposal in
  // yet. Once the reveal is up (or the profile is live) the interval stands down.
  const { data: proposals } = useQuery({
    ...profileProposalsQuery(profileId),
    refetchInterval: (q) => (art && !live && !q.state.data?.length ? 5000 : false),
  })
  const open = proposals?.[0]
  const [showBrief, setShowBrief] = useState(false)

  const approve = useApiMutation({
    mutationFn: (proposalId: string) => api.approveProposal(profileId, proposalId),
    success: "Brand profile approved — agents read it from now on",
    onSuccess: () => setShowBrief(false),
    invalidate: [artifactQuery(profileId).queryKey, profileProposalsQuery(profileId).queryKey],
  })

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

  if (open)
    return (
      <section className="flex flex-col gap-3" data-testid="brandprint-profile-reveal">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-medium text-foreground">Your brand profile is ready</h2>
            <p className="text-sm text-muted-foreground">
              Your agent distilled it from your sources. Approve it and every agent reads it before
              building anything here — or open it to comment and ask for changes.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild data-testid="brandprint-profile-review">
              <Link to="/artifacts/$ref" params={{ ref: refFor(art) }}>
                Review &amp; comment
              </Link>
            </Button>
            {ws?.role === "owner" ? (
              <Button
                size="sm"
                data-testid="brandprint-profile-approve"
                loading={approve.isPending}
                disabled={approve.isPending}
                onClick={() => approve.mutate(open.id)}
              >
                Approve
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">An admin approves this.</p>
            )}
          </div>
        </div>
        <ProfileFrame
          title="Proposed brand profile"
          src={`${API_BASE}/raw/${profileId}/p/${open.id}/index.html`}
        />
      </section>
    )

  if (live && !showBrief)
    return (
      <section className="flex flex-col gap-3" data-testid="brandprint-profile-live">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-medium text-foreground">Brand profile</h2>
            <p className="text-sm text-muted-foreground">
              Live — every agent connected to this workspace reads it before authoring.
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
3. Build our brand profile as ONE self-contained HTML file following the reference, and publish it with for_review: true to artifact ${profileId}.`

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
  // the queued state. The proposals poll above flips to the reveal when the build lands.
  const [queued, setQueued] = useState(false)
  const { data: agents = [] } = useQuery(artifactAgentsQuery(profileId))
  const usable = usableAgents(agents)
  const send = useApiMutation<{ requestId: string }, AgentTarget>({
    mutationFn: (agent) => api.generateProfile(profileId, agent.id),
    success: (_r, agent) =>
      `Build request queued for ${agent.name}. It runs the next time your agent checks in.`,
    errorToast: false,
    onError: (err) => {
      const code = err instanceof ApiError ? err.code : undefined
      if (code === "alreadyQueued") {
        setQueued(true)
        toast("Already queued. It runs the next time your agent checks in.")
      } else toast.error("Couldn't queue the build — copy the brief below instead.")
    },
    onSuccess: () => setQueued(true),
  })

  if (queued)
    return (
      <section
        className="flex flex-col gap-1 rounded-lg border bg-secondary/40 px-4 py-3"
        data-testid="brandprint-generate-queued"
      >
        <h2 className="text-base font-medium text-foreground">
          Your agent is building your Brandprint
        </h2>
        <p className="text-sm text-pretty text-muted-foreground">
          The build brief is queued to spec. The proposal lands here for your review — check back
          after your agent's next session, or leave this page open and it appears on its own.
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
          <h2 className="text-base font-medium text-foreground">
            {regenerating ? "Regenerate your brand profile" : "Finish with your agent"}
          </h2>
          <p className="text-sm text-pretty text-muted-foreground">
            {regenerating
              ? "Hand your agent the brief again and it rebuilds the profile from your current sources — the new version arrives here for approval."
              : "Your sources are saved and already guide connected agents. Now hand your agent this brief: it reads them, builds your brand profile, and sends it back here for your approval."}
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
          <SendToAgent agents={usable} pending={send.isPending} onPick={(a) => send.mutate(a)} />
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

// The one-click hand-off: fires the build brief into a registered agent's pull inbox
// (no copy-paste). Renders nothing without a registered agent — the copyable brief and
// ConnectAgentButton beside it remain that path. Sole agent fires directly; several
// open a picker (the AskAgentButton grammar, sized for this card).
function SendToAgent({
  agents,
  pending,
  onPick,
}: {
  agents: AgentTarget[]
  pending: boolean
  onPick: (agent: AgentTarget) => void
}) {
  if (agents.length === 0) return null
  const sole = agents.length === 1 ? agents[0] : null
  if (sole)
    return (
      <Button
        size="sm"
        data-testid="brandprint-generate"
        loading={pending}
        disabled={pending}
        onClick={() => onPick(sole)}
      >
        Send to {sole.name.split(/\s+/)[0]}
      </Button>
    )
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" data-testid="brandprint-generate" loading={pending} disabled={pending}>
          Send to your agent
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Send the build brief to</DropdownMenuLabel>
        {agents.map((a) => (
          <DropdownMenuItem
            key={a.id}
            data-testid={`brandprint-generate-${a.id}`}
            onSelect={() => onPick(a)}
          >
            {a.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// One recipe for both previews (proposal and live), the review overlay's exact
// sandboxed-iframe treatment at a fixed page-friendly height.
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
