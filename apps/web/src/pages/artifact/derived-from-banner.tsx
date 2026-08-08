import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError, type Artifact, api } from "@/api"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/sonner"
import { useAuth } from "@/ctx"
import { artifactAgentsQuery, workspaceSettingsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { AgentMenu, ALREADY_QUEUED, queuedFor, usableAgents } from "./ask-agent"
import { FillDialog } from "./fill-dialog"
import { refFor } from "./parse-ref"
import { resolveRework } from "./rework-state"
import type { AgentTarget } from "./types"

// The remix-provenance banner on a fresh copy ("use as template"): where it came
// from, and the two transform actions. The page mounts it only at v1 — the first
// publish makes the document its own — and the × dismisses per artifact for good.
// Provenance itself stays on the detail response either way.
const dismissKey = (shortId: string) => `derive:derived-banner:${shortId}`

export function DerivedFromBanner({ art }: { art: Artifact }) {
  const { me } = useAuth()
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(dismissKey(art.short_id)) === "1"
    } catch {
      return false
    }
  })
  const [fillOpen, setFillOpen] = useState(false)
  // A failed ambient read hides the Rebrand affordance rather than guessing at a
  // state from partial data (the rework-menu convention); Fill needs neither query.
  const { data: settings, isError: settingsError } = useQuery({
    ...workspaceSettingsQuery(),
    enabled: !!me,
  })
  const { data: agents = [], isError: agentsError } = useQuery({
    ...artifactAgentsQuery(art.short_id),
    enabled: !!me,
  })
  const rebrand = useApiMutation<{ requestId: string }, AgentTarget>({
    mutationFn: (a) => api.reworkArtifact(art.short_id, a.id),
    success: (_r, a) => queuedFor("Rework", a.name),
    errorToast: false,
    onError: (err) => {
      if (err instanceof ApiError && err.code === "alreadyQueued") toast(ALREADY_QUEUED)
      else toast.error("Rework request failed — try again.")
    },
  })
  // `derived_from` is null when the source stopped resolving (deleted/removed) —
  // nothing to link to or fill from, so no banner.
  const source = art.derived_from
  if (!source || dismissed || !me) return null
  // Rebrand needs a Brandprint and an addressable agent (the fire/picker states).
  // The setup/connect onboarding paths stay in the ⋯ menu's Rework item — a
  // provenance banner is the wrong place to start Brandprint setup from.
  const hasBrandprint =
    !!settings?.brandprint?.collectionId ||
    !!settings?.brandprint?.profileId ||
    !!me.brandprint?.collectionId
  const rework = resolveRework(
    hasBrandprint && !settingsError,
    agentsError ? [] : usableAgents(agents),
  )
  return (
    <div
      data-testid="derived-banner"
      className="flex shrink-0 items-center gap-2.5 border-b border-border bg-muted/40 px-4 py-1.5"
    >
      <Eyebrow className="shrink-0">Derived from</Eyebrow>
      <Link
        to="/artifacts/$ref"
        params={{ ref: refFor({ short_id: source.short_id, title: source.title }) }}
        className="min-w-0 truncate text-sm text-foreground hover:underline"
      >
        {source.title ?? source.short_id}
      </Link>
      <div className="min-w-0 flex-1" />
      {(rework.state === "fire" || rework.state === "picker") && (
        <AgentMenu
          agents={agents}
          menuLabel="Rebrand with which agent?"
          testidPrefix="banner-rebrand"
          align="end"
          onPick={(a) => rebrand.mutate(a)}
          trigger={({ onClick }) => (
            <Button
              variant="outline"
              size="sm"
              data-testid="banner-rebrand"
              disabled={rebrand.isPending}
              onClick={onClick}
            >
              Rebrand
            </Button>
          )}
        />
      )}
      <Button size="sm" data-testid="banner-fill" onClick={() => setFillOpen(true)}>
        Fill with your work
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Dismiss"
        data-testid="banner-dismiss"
        onClick={() => {
          try {
            localStorage.setItem(dismissKey(art.short_id), "1")
          } catch {
            // Storage unavailable: the banner still hides for this visit.
          }
          setDismissed(true)
        }}
      >
        ×
      </Button>
      <FillDialog
        shortId={art.short_id}
        agents={agents}
        open={fillOpen}
        onOpenChange={setFillOpen}
      />
    </div>
  )
}
