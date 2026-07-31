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
import { AgentPushListener } from "../components/chrome/agent-push"
import { AppShell } from "../components/chrome/app-shell"
import { BootShell } from "../components/chrome/boot-shell"
import { Toaster } from "../components/ui/sonner"
import { AuthProvider, CursorPrefProvider, ThemeProvider } from "../ctx"
import { CHROMELESS_EXACT, CHROMELESS_PREFIX, isChromelessPath } from "../lib/chrome-routes"
import { cacheRestored } from "../lib/persist"
import { queryClient } from "../lib/query-client"
import { STORAGE_KEYS } from "../lib/storage-keys"
import { reportWebVitals } from "../lib/vitals"
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

// The colour the BROWSER and OS paint around the app: Safari's toolbars, the Android
// status bar, and the title bar of an installed PWA. A meta tag cannot resolve a CSS
// custom property, so these mirror the two --background canvases in globals.css by
// hand; they are the most stable tokens we have, and the manifest carries the dark one
// for the install splash.
const THEME_COLOR = {
  light: "#f7f8fa", // tokens-ignore: mirrors --background (light) in globals.css
  dark: "#0a0b0d", // tokens-ignore: mirrors --background (.dark) in globals.css
}

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
      // Installed-app metadata. `mobile-web-app-capable` is the standard spelling
      // (Apple's own `apple-mobile-web-app-capable` is deprecated in favour of it, and
      // iOS 26 opens Home Screen sites as web apps regardless); the status-bar style is
      // still Apple-only, and `black-translucent` is what lets the app paint under the
      // notch, which the viewport's `viewport-fit=cover` above already asks for.
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "apple-mobile-web-app-title", content: "Derive" },
      // NOTE: theme-color is deliberately NOT here — see THEME_COLOR in RootDocument.
    ],
    links: [
      // Theme-aware: dark glyph on light browser chrome, light on dark
      // (prefers-color-scheme media query inside the SVG).
      { rel: "icon", type: "image/svg+xml", href: "/brand/favicon.svg" },
      { rel: "icon", type: "image/png", href: "/brand/favicon.png" },
      // Home Screen icon. favicon.png is a transparent white glyph, which vanishes
      // against the light tile iOS composites it onto — icon-192 is the opaque brand
      // tile meant for this, and it is what the manifest points at too.
      { rel: "apple-touch-icon", href: "/brand/icon-192.png" },
      { rel: "manifest", href: "/manifest.webmanifest" },
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
    if (import.meta.env.DEV && import.meta.env.VITE_REACT_SCAN) {
      import("react-scan").then(({ scan }) => scan({ enabled: true })).catch(() => {})
    }
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
        {/* One theme-color per scheme, rendered HERE rather than through the route's
            `head()`: head management DEDUPES meta by `name`, so two theme-color entries
            collapse to the last one and the light variant is dropped (verified against
            the served HTML). As raw tags both survive. */}
        <meta
          name="theme-color"
          content={THEME_COLOR.light}
          media="(prefers-color-scheme: light)"
        />
        <meta name="theme-color" content={THEME_COLOR.dark} media="(prefers-color-scheme: dark)" />
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static boot string built from a constant storage key, no user input.
          dangerouslySetInnerHTML={{ __html: THEME_BOOT }}
        />
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static boot string built from constant route lists, no user input.
          dangerouslySetInnerHTML={{ __html: BOOT_FRAME }}
        />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
