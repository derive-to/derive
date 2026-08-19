import { createReadStream, existsSync, statSync } from "node:fs"
import { extname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import babel from "@rolldown/plugin-babel"
import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react"
import { visualizer } from "rollup-plugin-visualizer"
import { defineConfig, type Plugin } from "vite"

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

// derive.to's own public surface (apps/web/hosted) sits outside public/ so that a
// self-host build never ships it — see scripts/build-hosted.mjs. That also puts it
// out of Vite's reach, so serve the same directory in development and the marketing
// pages, the trust files and the sitemap look exactly like production locally.
// Registered ahead of Vite's own middlewares so the hosted robots.txt overlays the
// generic one, which is the order the hosted build produces.
const HOSTED = fileURLToPath(new URL("./hosted", import.meta.url))
const HOSTED_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
}

const hostedSite = (): Plugin => ({
  name: "derive:hosted-site",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname)
      let file = resolve(HOSTED, `.${path}`)
      if (file !== HOSTED && !file.startsWith(`${HOSTED}${sep}`)) return next()
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html")
      if (!existsSync(file) || !statSync(file).isFile()) return next()
      res.setHeader("content-type", HOSTED_TYPES[extname(file)] ?? "application/octet-stream")
      createReadStream(file).pipe(res)
    })
  },
})

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
    hostedSite(),
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
