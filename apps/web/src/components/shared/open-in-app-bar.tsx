import { useEffect, useState } from "react"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { appDeepLink, isEmbeddedMobileBrowser, isStandalone } from "@/lib/in-app-browser"
import { STORAGE_KEYS } from "@/lib/storage-keys"

// The escape hatch out of a host app's in-app browser. A Derive link pasted into a
// Slack channel and tapped on a phone lands in Slack's own web view, where a universal
// link CANNOT reach the Derive app (Apple opens the site instead) — so the page offers
// the hop itself, on a custom scheme, which does escape a web view. See lib/in-app-browser
// for why this is detection-gated rather than an automatic redirect.
//
// Renders in flow, above the mobile top bar, so it never covers navigation the way a
// fixed overlay would. Same shape as BlockedBanner: `shrink-0` inside the shell's inset
// column, so it takes its own row and the page keeps the rest.
export function OpenInAppBar() {
  // The user agent and localStorage are browser-only, and the SPA ships a prerendered
  // static shell, so nothing may be decided before mount or hydration mismatches. Same
  // gate AppFrame uses for AppShell.
  const [show, setShow] = useState(false)
  useEffect(() => {
    let dismissed = true
    try {
      dismissed = localStorage.getItem(STORAGE_KEYS.openInAppBar) === "1"
    } catch {
      /* private mode — treat as dismissed rather than nagging every load */
    }
    if (dismissed || isStandalone()) return
    setShow(isEmbeddedMobileBrowser(navigator.userAgent))
  }, [])

  const dismiss = () => {
    setShow(false)
    try {
      localStorage.setItem(STORAGE_KEYS.openInAppBar, "1")
    } catch {
      /* private mode — the in-memory dismissal holds this session */
    }
  }

  // Hand the current URL over whole, so the app lands on this exact artifact (and its
  // ?comment= anchor) rather than the home screen. Nothing on the web can tell whether
  // the app is installed; if it is not, the scheme simply does nothing and the reader
  // stays on the page they already have, which is why this is a button and not a redirect.
  const openApp = () => {
    window.location.href = appDeepLink(window.location.href)
  }

  if (!show) return null
  return (
    <div
      role="status"
      data-testid="open-in-app-bar"
      className="flex shrink-0 items-center gap-2.5 border-b border-border bg-secondary px-3 py-2 text-sm"
    >
      {/* Host-agnostic copy: the same bar covers Slack, Teams, LinkedIn and the rest,
          and naming the wrong one reads as a bug to whoever is not in Slack. */}
      <span className="min-w-0 flex-1 text-muted-foreground">
        You&rsquo;re in an in-app browser.
      </span>
      <Button
        variant="outline"
        size="sm"
        data-testid="open-in-app-bar-open"
        onClick={openApp}
        className="shrink-0"
      >
        Open in Derive
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss"
        data-testid="open-in-app-bar-dismiss"
        onClick={dismiss}
        className="shrink-0 text-muted-foreground"
      >
        <Icon name="close" size={14} />
      </Button>
    </div>
  )
}
