import { Link } from "@tanstack/react-router"
import { useState } from "react"
import type { Artifact } from "@/api"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/ctx"
import { refFor } from "./parse-ref"

// The remix-provenance banner on a fresh copy ("use as template"): where it came from. The
// page mounts it only at v1 (the first publish makes the document its own) and the ×
// dismisses it per artifact for good. Provenance itself stays on the detail response either
// way. Asking an agent to fill or restyle the copy is the margin Ask now, like any page.
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
  // `derived_from` is null when the source stopped resolving (deleted/removed): nothing to
  // link to, so no banner.
  const source = art.derived_from
  if (!source || dismissed || !me) return null
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
    </div>
  )
}
