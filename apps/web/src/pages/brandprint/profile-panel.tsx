import { queryOptions, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { API_BASE, api } from "@/api"
import { ConnectAgentButton, PromptBlock, publicUrl } from "@/components/shared/connect-agent"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { artifactQuery, workspaceQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { refFor } from "../artifact/parse-ref"

/**
 * The workspace brand profile's home on /brandprint — the spec's five states, three of
 * which live here (the page covers "empty" and "no agent yet"; the latter is this
 * panel's hand-off card with Connect leading):
 * - hand-off: sources saved, profile still the stub, no proposal — the copyable brief.
 * - reveal: the agent's proposal is in — full-width preview, Approve, comments.
 * - live: an approved profile fronts the page; Regenerate re-surfaces the brief.
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
// agent was ever authorized — ConnectAgentButton is one tap away either way). Persistent
// and calm; the MCP never pitches, this card is the human-facing backstop. `onDismiss`
// present means a live profile exists and this is a regenerate.
function HandoffCard({ profileId, onDismiss }: { profileId: string; onDismiss?: () => void }) {
  const regenerating = !!onDismiss
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
