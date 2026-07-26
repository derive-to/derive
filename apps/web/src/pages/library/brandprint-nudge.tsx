import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/ctx"
import { workspaceQuery, workspaceSettingsQuery } from "@/lib/queries"
import { STORAGE_KEYS } from "@/lib/storage-keys"

// The spec's "first on the team" catch-all: Derive creates team workspaces at first
// need, often after onboarding, so the owner of a Brandprint-less workspace gets one
// quiet, dismissible nudge on the home — wherever that moment actually happens, not
// only at signup. Dismissal is per browser (localStorage); setting a Brandprint
// hides it everywhere for good. Ambient: a failed read just keeps it hidden.
export function BrandprintNudge() {
  const { me } = useAuth()
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEYS.brandprintNudge) === "1"
    } catch {
      return true
    }
  })
  const { data: ws, isError: wsError } = useQuery({ ...workspaceQuery(), enabled: !!me })
  const { data: settings, isError: settingsError } = useQuery({
    ...workspaceSettingsQuery(),
    enabled: !!me,
  })
  const dismiss = () => {
    setDismissed(true)
    try {
      localStorage.setItem(STORAGE_KEYS.brandprintNudge, "1")
    } catch {
      /* private mode — the in-memory dismissal holds this session */
    }
  }
  const show =
    !dismissed &&
    !wsError &&
    !settingsError &&
    ws?.role === "owner" &&
    !!settings &&
    !settings.brandprint?.collectionId
  if (!show) return null
  return (
    <div className="mb-6 flex items-center gap-2.5 rounded-lg bg-secondary px-3.5 py-2.5 text-sm">
      <Icon name="brandprint" size={16} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-pretty text-foreground">
        <Link
          to="/brandprint"
          data-testid="library-brandprint-nudge"
          className="font-medium underline-offset-4 hover:underline"
        >
          Set up your team&rsquo;s Brandprint
        </Link>
        <span className="text-muted-foreground">
          : your voice and visual style, read automatically by every agent that works here.
        </span>
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss"
        data-testid="library-brandprint-nudge-dismiss"
        onClick={dismiss}
        className="shrink-0 text-muted-foreground"
      >
        <Icon name="close" size={14} />
      </Button>
    </div>
  )
}
