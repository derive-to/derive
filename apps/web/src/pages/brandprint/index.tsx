import { useQuery } from "@tanstack/react-query"
import { ConnectAgentButton } from "@/components/shared/connect-agent"
import { useAuth } from "@/ctx"
import { connectedAgentsQuery, workspaceSettingsQuery } from "@/lib/queries"
import { BrandprintSection } from "./brandprint-section"
import { ProfilePanel } from "./profile-panel"

// The workspace's conventions and your personal layer, composed. The sections own
// their data, states, and writes; this is composition only. The top band is exclusive
// by construction: the brand profile's panel when one exists, else the saved-but-inert
// nudge. The caller supplies the surrounding heading and shell — today that's the Brand
// settings section.
export function BrandprintBody() {
  const { me } = useAuth()
  const { data: settings } = useQuery({ ...workspaceSettingsQuery(), enabled: !!me })
  const profileId = settings?.brandprint?.profileId ?? undefined
  return (
    <div className="flex flex-col gap-8">
      {profileId ? <ProfilePanel profileId={profileId} /> : <ApplyNudge />}
      <BrandprintSection scope="workspace" />
      <BrandprintSection scope="account" />
    </div>
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
        is reading it yet. Connect your coding agent and it applies to the next thing it builds.
      </p>
      <ConnectAgentButton variant="secondary" size="sm" testId="brandprint-connect-agent" />
    </div>
  )
}
