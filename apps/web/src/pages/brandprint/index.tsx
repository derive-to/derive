import { useQuery } from "@tanstack/react-query"
import { ConnectAgentButton } from "@/components/shared/connect-agent"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { Skeleton } from "@/components/ui/skeleton"
import { useAuth } from "@/ctx"
import { connectedAgentsQuery, workspaceSettingsQuery } from "@/lib/queries"
import { useDocumentTitle } from "@/lib/use-document-title"
import { BrandprintSection } from "./brandprint-section"
import { ProfilePanel } from "./profile-panel"

// The Brandprint page: /brandprint — the workspace's conventions and your personal
// layer, one destination in the rail (a peer of Contexts). Promoted out of Settings:
// a Brandprint is something a team sets up and returns to, not a preference. The
// sections own their data, states, and writes; this page is composition only. The
// top band is exclusive by construction: the brand profile's panel when one exists,
// else the saved-but-inert nudge.
export function Brandprint() {
  useDocumentTitle("Brandprint")
  const { me } = useAuth()
  const { data: settings } = useQuery({ ...workspaceSettingsQuery(), enabled: !!me })
  const profileId = settings?.brandprint?.profileId ?? undefined
  return (
    <PageShell className="flex flex-col gap-8">
      <PageHeader
        title="Brandprint"
        subtitle="The conventions your artifacts follow: how they look and how they read. Any agent connected to this workspace picks them up automatically."
      />
      {profileId ? <ProfilePanel profileId={profileId} /> : <ApplyNudge />}
      <BrandprintSection scope="workspace" />
      <BrandprintSection scope="account" />
    </PageShell>
  )
}

// The saved-but-inert state: a Brandprint exists but the caller has never authorized
// an agent, so nothing is reading it. The honest framing from the spec — captured and
// saved now, applied the moment an agent connects — with the shared Connect surface
// one tap away. Ambient: any load failure just keeps the band hidden. Only mounted
// when no brand profile exists (the page branches above); the panel's states carry
// the connect story otherwise.
function ApplyNudge() {
  const { me } = useAuth()
  const { data: settings } = useQuery({ ...workspaceSettingsQuery(), enabled: !!me })
  const { data: agents, isError } = useQuery({ ...connectedAgentsQuery(), enabled: !!me })
  const hasBrandprint = !!settings?.brandprint?.collectionId || !!me?.brandprint?.collectionId
  if (isError || !hasBrandprint || !agents || agents.length > 0) return null
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-secondary/40 px-4 py-3">
      <p className="text-sm text-pretty text-muted-foreground">
        <span className="font-medium text-foreground">Your Brandprint is saved</span>, but nothing
        is reading it yet. Connect an agent and it applies from the very next thing it builds.
      </p>
      <ConnectAgentButton variant="secondary" size="sm" testId="brandprint-connect-agent" />
    </div>
  )
}

// Deterministic silhouette: the header band, then two group-shaped blocks (title
// line, description line, a row) matching the sections above. Announced by the
// sr-only status line, the RailSkeleton idiom.
const PENDING_GROUPS = ["workspace", "account"]

export function BrandprintPending() {
  return (
    <PageShell className="flex flex-col gap-8">
      <span role="status" className="sr-only">
        Loading Brandprint…
      </span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-4 w-3/4" />
      </div>
      {PENDING_GROUPS.map((k) => (
        <div key={k} className="flex flex-col gap-3">
          <Skeleton className="h-5 w-52" />
          <Skeleton className="h-4 w-2/3" />
          <div className="flex items-center justify-between py-3.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-8 w-36" />
          </div>
        </div>
      ))}
    </PageShell>
  )
}
