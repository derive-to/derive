import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Copy } from "lucide-react"
import { useState } from "react"
import { API_BASE, api } from "@/api"
import { Icon } from "@/components/icons"
import { ConnectAgentButton, publicUrlOf } from "@/components/shared/connect-agent"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "@/components/ui/sonner"
import { useAuth } from "@/ctx"
import { workspaceQuery, workspaceSettingsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { refFor } from "../artifact/parse-ref"

/**
 * The workspace brand profile's home on /brandprint — the spec's five states, three of
 * which live here (the section below covers "empty", and "no agent yet" is this panel's
 * hand-off card with Connect leading):
 * - hand-off: sources saved, profile still the stub, no proposal — the copyable brief.
 * - reveal: the agent's proposal is in — full-width preview, Approve, comments.
 * - live: an approved profile fronts the page; Regenerate re-surfaces the brief.
 * Renders nothing without a profileId (legacy Brandprints keep the pre-profile page).
 */
export function ProfilePanel() {
  const { me } = useAuth()
  const { data: settings } = useQuery({ ...workspaceSettingsQuery(), enabled: !!me })
  const profileId = settings?.brandprint?.profileId ?? undefined
  if (!profileId) return null
  return <ProfileStates profileId={profileId} />
}

const profileArtifactQuery = (profileId: string) => ({
  queryKey: ["artifacts", "brandprint-profile", profileId] as const,
  queryFn: () => api.getArtifact(profileId),
})
const profileProposalsQuery = (profileId: string) => ({
  queryKey: ["brandprint-profile-proposals", profileId] as const,
  queryFn: () => api.listProposals(profileId, "open").then((r) => r.proposals),
})

function ProfileStates({ profileId }: { profileId: string }) {
  const { data: ws } = useQuery(workspaceQuery())
  const { data: art, isError: artError } = useQuery(profileArtifactQuery(profileId))
  const live = (art?.current_version ?? 0) >= 2
  // While we wait on the agent, poll for the proposal so the reveal fires the moment
  // it lands — the page flips from "building" to the preview without a reload.
  const { data: proposals } = useQuery({
    ...profileProposalsQuery(profileId),
    refetchInterval: art && !live ? 5000 : false,
  })
  const open = proposals?.[0]
  const [showBrief, setShowBrief] = useState(false)

  const approve = useApiMutation({
    mutationFn: (proposalId: string) => api.approveProposal(profileId, proposalId),
    success: "Brand profile approved — agents read it from now on",
    onSuccess: () => setShowBrief(false),
    invalidate: [
      profileArtifactQuery(profileId).queryKey,
      profileProposalsQuery(profileId).queryKey,
    ],
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

  return (
    <HandoffCard
      profileId={profileId}
      regenerating={live}
      onDismiss={live ? () => setShowBrief(false) : undefined}
    />
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
// and calm; the MCP never pitches, this card is the human-facing backstop.
function HandoffCard({
  profileId,
  regenerating,
  onDismiss,
}: {
  profileId: string
  regenerating: boolean
  onDismiss?: () => void
}) {
  const [copied, setCopied] = useState(false)
  const url = typeof window !== "undefined" ? publicUrlOf(window.location.origin) : ""
  const brief = briefFor(url, profileId)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(brief)
      setCopied(true)
      toast.success("Copied — paste it into your agent")
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("Couldn't copy; select the text and copy it manually")
    }
  }
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
      <div className="relative">
        <pre
          data-testid="brandprint-brief"
          className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border bg-secondary p-3 pr-12 font-mono text-sm text-foreground"
        >
          {brief}
        </pre>
        <Button
          variant="outline"
          size="icon-sm"
          data-testid="brandprint-brief-copy"
          aria-label="Copy the brief"
          className="absolute right-2 top-2"
          onClick={copy}
        >
          {copied ? <Icon name="check" className="text-success" /> : <Copy className="size-4" />}
        </Button>
      </div>
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
