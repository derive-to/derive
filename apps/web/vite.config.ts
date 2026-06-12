import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const API = process.env.DOCK_API ?? "http://localhost:8090"

// Dev: proxy the API so the SPA is same-origin (session cookies work).
export default defineConfig({
  plugins: [react()],
  esbuild: { target: "esnext" },
  optimizeDeps: { esbuildOptions: { target: "esnext" } },
  build: { target: "esnext" },
  server: {
    port: 3000,
    // NOTE: /a is the SPA's own route — only proxy API + raw artifact bytes.
    proxy: Object.fromEntries(
      ["/v1", "/api", "/raw", "/healthz"].map((p) => [p, { target: API, changeOrigin: true }]),
    ),
  },
})
