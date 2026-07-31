import { fileURLToPath } from "node:url"
import babel from "@rolldown/plugin-babel"
import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react"
import { visualizer } from "rollup-plugin-visualizer"
import { defineConfig } from "vite"

const API = process.env.DERIVE_API ?? "http://localhost:8090"

// A build identity that changes when the app does — the persisted-cache buster (lib/persist.ts):
// a deploy that alters a response shape must never restore stale-shaped data. Commit SHA in CI,
// a per-start timestamp locally.
const BUILD_ID = process.env.GITHUB_SHA?.slice(0, 8) ?? String(Date.now())

// `ANALYZE=1 pnpm build` writes a gzip treemap to dist/stats.html for spotting
// what's heavy. Off by default so normal builds don't open a browser tab.
const analyze = process.env.ANALYZE
  ? [visualizer({ filename: "dist/stats.html", gzipSize: true, template: "treemap" })]
  : []

// TanStack Start in SPA mode: prerenders a static shell, hydrates a client-side
// router. No SSR, no server runtime — the build is a static bundle for any CDN.
// The Hono API stays a separate origin; the dev proxy keeps it same-origin so
// session cookies work locally.
export default defineConfig({
  // Compile-time constant read by lib/persist.ts as the query-cache buster.
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    // Emit .vite/manifest.json so the bundle budget can tell the eager critical
    // path (entry + its static-import closure) apart from lazy route chunks, and
    // gate the two separately (scripts/check-bundle.mjs).
    manifest: true,
    rollupOptions: {
      output: {
        // Keep React/runtime in its own vendor chunk so app changes don't bust
        // its cache (and the entry chunk stays lean) — React 19's react-dom would
        // otherwise fold into the entry.
        manualChunks: (id) =>
          /node_modules\/(react|react-dom|scheduler|react-compiler-runtime)\//.test(id)
            ? "react-vendor"
            : undefined,
      },
    },
  },
  server: {
    port: 3090,
    // /artifacts is the SPA's own route — only proxy API + raw artifact bytes + the
    // server-rendered OAuth consent page.
    proxy: Object.fromEntries(
      [
        "/v1",
        "/api",
        "/raw",
        "/blob",
        "/healthz",
        "/readyz",
        "/oauth",
        "/.well-known/skills",
        "/mcp",
        "/openapi.json",
        "/docs",
        "/.well-known/oauth-authorization-server",
        "/.well-known/oauth-protected-resource",
        "/.well-known/openid-configuration",
        "/skill.md",
        "/.well-known/agent.json",
      ].map((p) => [p, { target: API, changeOrigin: true }]),
    ),
  },
  plugins: [
    tailwindcss(),
    tanstackStart({ spa: { enabled: true } }),
    viteReact(),
    // React Compiler (stable, React 19) auto-memoizes components/hooks — it
    // retires hand-rolled useMemo/useCallback and the exhaustive-deps papercuts.
    // Wired the plugin-react v6 way: a Rolldown babel pass running the preset.
    babel({ presets: [reactCompilerPreset()] }),
    ...analyze,
  ],
})
