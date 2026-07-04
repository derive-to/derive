import type { QueryClient } from "@tanstack/react-query"
import { QueryClientProvider } from "@tanstack/react-query"
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  useRouterState,
} from "@tanstack/react-router"
import { type ReactNode, useEffect, useState } from "react"
import { AppShell } from "../components/chrome/app-shell"
import { AppBoot } from "../components/shared/app-boot"
import { Toaster } from "../components/ui/sonner"
import { AuthProvider, CursorPrefProvider, ThemeProvider } from "../ctx"
import { queryClient } from "../lib/query-client"
import { STORAGE_KEYS } from "../lib/storage-keys"
import { reportWebVitals } from "../lib/vitals"
import "@/styles/globals.css"

// Resolve the theme before first paint so there's no flash: a stored light/dark
// choice wins, otherwise follow the OS preference. Mirrors resolveTheme() in ctx
// so the pre-paint attribute matches what ThemeProvider settles on post-hydration.
// Runs synchronously in <head>, ahead of body render. Keyed off STORAGE_KEYS.theme
// (not a literal) so it tracks the one key definition and stays out of the
// storage-key linter's way.
const THEME_BOOT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  STORAGE_KEYS.theme,
)});if(t!=="light"&&t!=="dark")t="dark";var e=document.documentElement;e.classList.remove("light","dark");e.classList.add(t)}catch(e){}})()`

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
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
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/brand/logo-light.svg" },
      { rel: "icon", type: "image/png", href: "/brand/favicon.png" },
      { rel: "apple-touch-icon", href: "/brand/favicon.png" },
      // Fonts are self-hosted via @fontsource-variable imports in globals.css —
      // Geist Sans + Geist Mono (both weight-only), so no third-party request.
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
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AuthProvider>
            <CursorPrefProvider>
              <AppFrame />
            </CursorPrefProvider>
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
  // Hydration gate. Until the client has mounted, render the neutral AppBoot — the
  // SAME thing the SPA prerender bakes into the static shell — so the first client
  // paint matches the prerendered HTML exactly (clean hydration, no flash). One
  // tick later the route-correct chrome renders, INSTANTLY, not gated on the me()
  // query (identity atoms skeleton in during its latency). This is a one-time
  // cold-boot frame: in-app navs keep the chrome mounted and never see it again.
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])

  // /login and /welcome (first-run onboarding) render chrome-less — no rail/top bar.
  // /showcase is the design canvas and renders chrome-less too.
  const chromeless = useRouterState({
    select: (s) =>
      s.location.pathname === "/login" ||
      s.location.pathname === "/welcome" ||
      s.location.pathname === "/showcase",
  })

  if (!hydrated) return <AppBoot />
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
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
