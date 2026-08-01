/**
 * The native tab bar's model: which tabs exist, which one a path belongs to, and the
 * script that moves the hosted app.
 *
 * WHY A NATIVE TAB BAR AT ALL. It is the most-cited thing that separates an app from a
 * repackaged website under App Store Guideline 4.2, alongside push. It is also just
 * better: a tab is one tap from anywhere instead of a hamburger plus a menu row.
 *
 * WHY IT DRIVES THE SPA'S ROUTER RATHER THAN RELOADING. Setting the web view's source
 * re-fetches the document and re-boots the app, so every tab switch would read as a page
 * load — the exact tell that a shell is a browser in disguise. Pushing history and firing
 * `popstate` hands the change to the client-side router instead, which is instant and
 * keeps the app's state. Verified against the running app: three tab switches, zero full
 * page loads, correct screen each time.
 *
 * Pure on purpose: no React, no Expo, so the mapping and the script are testable without
 * a device — and the mapping is the part that silently rots when a route is renamed.
 */

export interface Tab {
  /** Stable key, and the test id. */
  key: string
  label: string
  /** The web path this tab shows. */
  path: string
  /** Every path prefix that should light this tab up. */
  owns: string[]
}

/**
 * Four tabs, matching what the web app's own nav puts first. Deliberately NOT every nav
 * row: a tab bar that mirrors a sidebar is a sidebar with worse ergonomics. The rest stay
 * one tap away in the web app's drawer.
 */
export const TABS: Tab[] = [
  { key: "library", label: "Library", path: "/", owns: ["/"] },
  { key: "favorites", label: "Favorites", path: "/favorites", owns: ["/favorites"] },
  { key: "following", label: "Following", path: "/following", owns: ["/following"] },
  { key: "settings", label: "Settings", path: "/settings", owns: ["/settings"] },
]

/** The path part of a url, or "/" when it will not parse. */
export const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname || "/"
  } catch {
    return "/"
  }
}

/**
 * Which tab a url belongs to, or null when none does.
 *
 * Null is a real answer, not a fallback to Library: an artifact, a profile or the
 * brandprint is not "in" a tab, and lighting one up there would say the person is
 * somewhere they are not. The bar still shows; nothing is selected.
 */
export const activeTabFor = (url: string): string | null => {
  const path = pathOf(url).replace(/\/+$/, "") || "/"
  let best: Tab | null = null
  for (const t of TABS) {
    for (const own of t.owns) {
      // "/" must match only itself, or it would own every path.
      const hit = own === "/" ? path === "/" : path === own || path.startsWith(`${own}/`)
      // Longest owned prefix wins, so a more specific tab beats a broader one.
      if (hit && (!best || own.length > Math.max(...best.owns.map((o) => o.length)))) best = t
    }
  }
  return best?.key ?? null
}

/**
 * Move the hosted app to `path` WITHOUT reloading it.
 *
 * `path` comes from TABS, never from user input, but it is JSON-encoded anyway so this
 * cannot become an injection sink if that ever stops being true.
 */
export const navScript = (path: string): string => `
(function () {
  try {
    if (location.pathname === ${JSON.stringify(path)}) {
      // Already here: scroll to top, which is what a tab re-tap means everywhere else.
      window.scrollTo({ top: 0, behavior: "smooth" })
      return
    }
    history.pushState({}, "", ${JSON.stringify(path)})
    dispatchEvent(new PopStateEvent("popstate"))
  } catch (e) {}
})();
true;
`
