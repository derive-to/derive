import { useEffect, useState } from "react"
import { takeFromSearch } from "./one-shot-params"

// The one-shot URL-param handshake: read the named params exactly once on
// mount, then strip them from the address bar so a reload (or a copied link)
// can't replay the moment. One hook for what billing (?checkout=success),
// sources (?connected=1), general (?new-workspace=1), Slack (?slack_connected /
// ?slack_error) and GitHub (?gh_install / ?gh_error) each hand-rolled — three
// different replaceState signatures between them. history.state is preserved
// so the router's own state survives the strip.
export function useOneShotParams(...names: string[]): Record<string, string> {
  const [taken] = useState(() =>
    typeof window === "undefined" ? {} : takeFromSearch(window.location.search, names).taken,
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: strip exactly once, on mount — `names` is a per-call-site literal list and `taken` is frozen from the first render
  useEffect(() => {
    if (Object.keys(taken).length === 0) return
    const { rest } = takeFromSearch(window.location.search, names)
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`,
    )
  }, [])
  return taken
}
