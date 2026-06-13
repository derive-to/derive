import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const API = process.env.DOCK_API ?? "http://localhost:8090"

// TanStack Start in SPA mode: prerenders a static shell, hydrates a client-side
// router. No SSR, no server runtime — the build is a static bundle for any CDN.
// The Hono API stays a separate origin; the dev proxy keeps it same-origin so
// session cookies work locally.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 3000,
    // /a is the SPA's own route — only proxy API + raw artifact bytes.
    proxy: Object.fromEntries(
      ["/v1", "/api", "/raw", "/healthz"].map((p) => [p, { target: API, changeOrigin: true }]),
    ),
  },
  plugins: [tailwindcss(), tanstackStart({ spa: { enabled: true } }), viteReact()],
})
