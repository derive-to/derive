import { useEffect } from "react"

// The prerendered shell and the root route's head both title the tab "Derive".
const BASE_TITLE = "Derive"

/**
 * Title the browser tab "<name> · Derive" while mounted; pass a falsy name
 * (still loading, not found) to leave the base title in place.
 *
 * Set imperatively rather than via a route head() because the data lives in the
 * query cache, not loader data — the tab tracks client-side loads the best-effort
 * loader missed, and renames. The unmount restore is load-bearing: HeadContent
 * only rewrites <title> when its own vdom changes, so a manual document.title
 * would otherwise outlive the page it named.
 */
export function useDocumentTitle(name: string | null | undefined) {
  useEffect(() => {
    if (!name) return
    document.title = `${name} · Derive`
    return () => {
      document.title = BASE_TITLE
    }
  }, [name])
}
