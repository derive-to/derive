// Web-build static namespaces: Vite's hashed /assets, the marketing /site and /brand
// files, and /blog (generated into the build by apps/web/scripts/build-blog.mjs).
// A pure leaf (no imports) because both sides of the deployment need it — the Node
// path contract (lib/serve-web) and the Worker's asset passthrough (worker.ts), and
// the worker bundle must not inherit serve-web's dependency on @hono/node-server.
//
// Why these are worker-first at all: Cloudflare Static Assets routing is path-only
// and HOST-BLIND, so without worker-first these paths on a vanity/draft host
// (`x.derive.page/assets/logo.png`) never reach domain mode — they miss the web
// build's files and fall into SPA not-found handling, serving the app shell where
// a bundle's own asset should be. Worker-first sends them through the Worker,
// which passes app-host requests straight back to the ASSETS binding and lets
// vanity hosts hit domain mode.
export const STATIC_NAMESPACE_PREFIXES = ["/assets", "/site", "/brand", "/blog"] as const
