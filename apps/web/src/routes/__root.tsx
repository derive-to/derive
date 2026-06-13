import type { QueryClient } from "@tanstack/react-query"
import { QueryClientProvider } from "@tanstack/react-query"
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router"
import { type ReactNode, useEffect } from "react"
import { AuthProvider, ThemeProvider } from "../ctx"
import { queryClient } from "../lib/query-client"
import { reportWebVitals } from "../lib/vitals"
import "@/styles/globals.css"

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Dock" },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap",
      },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  // Report web vitals to the console for before/after perf numbers. react-scan
  // (flags wasted re-renders) is opt-in via VITE_REACT_SCAN — its overlay
  // intercepts pointer events, so it must stay off by default in dev and under
  // e2e. Dev-only + dynamic import: dead-code-eliminated from the prod build.
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
            <Outlet />
          </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </RootDocument>
  )
}

function RootDocument({ children }: { children: ReactNode }) {
  // data-theme seeds the prerendered shell; ThemeProvider swaps it client-side.
  return (
    <html lang="en" data-theme="paper">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
