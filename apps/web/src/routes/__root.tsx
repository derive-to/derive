// Vite resolves these to the same hashed assets the fontsource CSS references, so
// preloading them starts the font fetch with the document instead of serialised
// behind the stylesheet that @imports it (the only latin-variable files; italics
// and other subsets stay lazy).
import geistUrl from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url"
import geistMonoUrl from "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?url"
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  useRouterState,
} from "@tanstack/react-router"
import { type ReactNode, useEffect, useState } from "react"
import { API_BASE, artifactsListPath } from "../api"
import { AgentPushListener } from "../components/chrome/agent-push"
import { AppShell } from "../components/chrome/app-shell"
import { BootShell } from "../components/chrome/boot-shell"
import { Toaster } from "../components/ui/sonner"
import { AuthProvider, CursorPrefProvider, ThemeProvider } from "../ctx"
import { releaseUnclaimedBootResponses } from "../lib/boot-fetch"
import { CHROMELESS_EXACT, CHROMELESS_PREFIX, isChromelessPath } from "../lib/chrome-routes"
import { cacheRestored } from "../lib/persist"
import { LIBRARY_PAGE } from "../lib/queries"
import { queryClient } from "../lib/query-client"
import { STORAGE_KEYS } from "../lib/storage-keys"
import { reportWebVitals } from "../lib/vitals"
import { DEFAULT_SORT } from "../pages/library/sort"
import { LIBRARY_SEARCH_PARAMS } from "../pages/library/types"
import "@/styles/globals.css"

// Resolve the theme before first paint so there's no flash: a stored light/dark
// choice wins; "system" (or nothing stored) follows the OS preference. Mirrors the
// ThemeProvider config in ctx (defaultTheme system + enableSystem) so the pre-paint
// class matches what next-themes settles on post-hydration. Runs synchronously in
// <head>, ahead of body render. Keyed off STORAGE_KEYS.theme (not a literal) so it
// tracks the one key definition and stays out of the storage-key linter's way.
const THEME_BOOT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  STORAGE_KEYS.theme,
)});if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";var e=document.documentElement;e.classList.remove("light","dark");e.classList.add(t)}catch(e){}})()`

// Google and other crawlers see the dark, light-surface-safe hrefs in the raw
// document. Once the browser has parsed those links, swap to the white variants
// only when its own chrome is dark. This follows the same split GitHub uses:
// crawler-safe defaults in HTML, browser-only theme selection afterwards.
const FAVICON_BOOT = `(function(){var m=matchMedia("(prefers-color-scheme: light)");var a=function(){document.querySelectorAll("[data-theme-favicon]").forEach(function(e){var l=e.getAttribute("data-light-href")||e.getAttribute("href");if(l&&!e.getAttribute("data-light-href"))e.setAttribute("data-light-href",l);var d=e.getAttribute("data-dark-href");if(l)e.setAttribute("href",m.matches?l:(d||l))})};a();m.addEventListener("change",a)})()`

// Pre-paint sibling to THEME_BOOT: tag <html> with which boot frame to reserve —
// before the shell paints — from the persisted auth hint AND the entry path. A
// returning signed-in user (hint set) on an app route gets the rail silhouette;
// everyone else (an anon, or a chromeless auth/onboarding route) gets the neutral
// mark. globals.css keys the two off data-boot; BootShell renders both. Inlined as a
// string so it runs before any module loads — kept in lockstep via the shared route
// lists + STORAGE_KEYS. A stale hint (since-expired session) self-corrects next load.
const BOOT_FRAME = `(function(){try{var p=location.pathname;var authed=localStorage.getItem(${JSON.stringify(
  STORAGE_KEYS.authed,
)})==="1";var e=${JSON.stringify(CHROMELESS_EXACT)};var f=${JSON.stringify(
  CHROMELESS_PREFIX,
)};var b=!authed||e.indexOf(p)>=0||f.some(function(x){return p.indexOf(x)===0});document.documentElement.setAttribute("data-boot",b?"bare":"rail")}catch(_){}})()`

/** The two requests a signed-in cold boot always makes, as the EXACT URLs the api client
 *  would build. Shared with `f()` in api.ts through `artifactsListPath`, so the head-start
 *  and the real call cannot disagree; boot-fetch.test.ts pins the pairing end to end. */
export const BOOT_START_URLS = {
  bootstrap: `${API_BASE}/v1/bootstrap`,
  homeList:
    API_BASE +
    artifactsListPath({ limit: LIBRARY_PAGE, sort: DEFAULT_SORT, excludeWorkflows: true }),
} as const

// Third pre-paint sibling, and the only one that touches the network: START the boot's
// API requests here, before a single module has loaded.
//
// Measured on the preview, a cold signed-in boot served its document in 45ms and then sat
// idle: the first API request (get-session) left at 269ms and the library list at 297ms,
// because both waited on the bundle to download, parse and hydrate. The list itself takes
// ~477ms, so first-card landed at ~790ms with a third of that spent doing nothing.
//
// This hands the in-flight promises to lib/boot-fetch, which api.ts claims instead of
// opening its own — a handoff of a real request, not a cache hint, so nothing depends on
// the browser deciding to reuse a preload (the trap that made <link rel=prefetch> useless
// for the artifact viewer). The gating table lives in lib/boot-fetch.ts.
//
// Same lockstep discipline as BOOT_FRAME: the route lists, the storage key and the URLs
// are all interpolated from the shared definitions rather than retyped.
const DATA_BOOT = `(function(){try{if(localStorage.getItem(${JSON.stringify(
  STORAGE_KEYS.authed,
)})!=="1")return;var p=location.pathname;var e=${JSON.stringify(
  CHROMELESS_EXACT,
)};var f=${JSON.stringify(
  CHROMELESS_PREFIX,
)};if(e.indexOf(p)>=0||f.some(function(x){return p.indexOf(x)===0}))return;var o={};var g=function(u){o[u]=fetch(u,{credentials:"include",headers:{accept:"application/json"}})};g(${JSON.stringify(
  BOOT_START_URLS.bootstrap,
)});var q=new URLSearchParams(location.search);var n=${JSON.stringify(
  LIBRARY_SEARCH_PARAMS,
)};if(p==="/"&&!n.some(function(k){return q.has(k)}))g(${JSON.stringify(
  BOOT_START_URLS.homeList,
)});window.__deriveBoot=o}catch(_){}})()`

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  // Gate ALL route loading on the IndexedDB cache restore, so a loader's ensureQueryData reads
  // the persisted data instead of fetching cold before it lands — the ordering that lets a
  // reload paint from cache like a nav. Resolved-instant after the first boot; never rejects.
  beforeLoad: async () => {
    await cacheRestored
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        // viewport-fit=cover exposes the notch/home-indicator safe-area insets;
        // interactive-widget is harmless on iOS (no-op) and helps Android resize.
        name: "viewport",
        content:
          "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content",
      },
      { title: "Derive" },
      // The authenticated/client shell is not a search landing page. Public
      // artifact and profile handlers replace this with index,follow only after
      // they have verified that the underlying record is genuinely public.
      { name: "robots", content: "noindex,nofollow" },
    ],
    links: [
      {
        rel: "icon",
        type: "image/png",
        sizes: "512x512",
        href: "/brand/favicon.png",
        "data-theme-favicon": "",
        "data-dark-href": "/brand/favicon-dark.png",
      },
      {
        rel: "icon",
        type: "image/svg+xml",
        href: "/brand/favicon.svg",
        "data-theme-favicon": "",
        "data-dark-href": "/brand/favicon-dark.svg",
      },
      { rel: "apple-touch-icon", href: "/brand/favicon.png" },
      // Fonts are self-hosted via @fontsource-variable imports in globals.css —
      // Geist Sans + Geist Mono (both weight-only), so no third-party request.
      // Preloaded so the fetch is not discovered late through the stylesheet:
      // crossOrigin is required for font destinations even same-origin, or the
      // preload is re-fetched and wasted.
      { rel: "preload", as: "font", type: "font/woff2", crossOrigin: "anonymous", href: geistUrl },
      {
        rel: "preload",
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
        href: geistMonoUrl,
      },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  // Perf instrumentation. web-vitals self-gates its sinks: console in dev (no
  // prod noise), and a field beacon when VITE_VITALS_URL is set — so it runs in
  // prod to collect real LCP/INP/CLS. react-scan (flags wasted re-renders) is
  // dev-only + behind VITE_REACT_SCAN (its overlay intercepts pointer events);
  // that dynamic import is dead-code-eliminated from the prod build.
  useEffect(() => {
    reportWebVitals()
    // Anything the head-start put on the wire has been claimed by now (the boot queries
    // run in the first route's loader, well inside this window) — drop the rest so a URL
    // that ever drifts leaks a request, not also a Response.
    const claimed = setTimeout(releaseUnclaimedBootResponses, 10_000)
    if (import.meta.env.DEV && import.meta.env.VITE_REACT_SCAN) {
      import("react-scan").then(({ scan }) => scan({ enabled: true })).catch(() => {})
    }
    return () => clearTimeout(claimed)
  }, [])
  return (
    <RootDocument>
      {/* The cache is persisted to IndexedDB (lib/persist.ts) and restored before any route
          loads (the root beforeLoad), so a reload paints from the same warm cache as a nav. */}
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AuthProvider>
            <CursorPrefProvider>
              <AppFrame />
            </CursorPrefProvider>
            {/* Auto-open on agent push: one app-wide listener on the shared
                per-user stream (renders nothing). Inside AuthProvider for `me`,
                inside the router tree for navigation. */}
            <AgentPushListener />
          </AuthProvider>
          {/* Inside ThemeProvider so sonner's useTheme() tracks the app's forced
              theme rather than falling back to the OS preference. */}
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>
    </RootDocument>
  )
}

// AppShell (persistent rail + top bar) wraps every authed route's Outlet and is
// mounted once here, so navigating between pages morphs only the content — the
// rail never remounts. /login is the one chrome-less route.
function AppFrame() {
  // Hydration gate. AppShell reads browser-only state (matchMedia, the persisted rail
  // width), so it can't render identically on the prerendered static shell; until the
  // client mounts we show BootShell — the SAME shell silhouette the SPA prerender bakes
  // in — so the first client paint matches the static HTML (clean hydration) AND the
  // rail is already in place, so the swap to real chrome a tick later is seamless (no
  // centered-logo → app-layout jump). One-time: in-app navs keep the chrome mounted and
  // never see it again.
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])

  // /login, /reset-password, /welcome (onboarding), /showcase, /invite/* render
  // chrome-less — no rail. The one list, shared with the boot script (lib/chrome-routes).
  const chromeless = useRouterState({ select: (s) => isChromelessPath(s.location.pathname) })

  if (!hydrated) return <BootShell />
  return chromeless ? (
    <Outlet />
  ) : (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}

function RootDocument({ children }: { children: ReactNode }) {
  // data-theme seeds the prerendered shell; ThemeProvider swaps it client-side.
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static boot string built from a constant storage key, no user input.
          dangerouslySetInnerHTML={{ __html: THEME_BOOT }}
        />
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static boot string built from constant route lists, no user input.
          dangerouslySetInnerHTML={{ __html: BOOT_FRAME }}
        />
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static boot string built from constant route lists + build-time URLs, no user input.
          dangerouslySetInnerHTML={{ __html: DATA_BOOT }}
        />
        <HeadContent />
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static favicon paths only, no user input.
          dangerouslySetInnerHTML={{ __html: FAVICON_BOOT }}
        />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
