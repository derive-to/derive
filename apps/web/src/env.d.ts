// Compile-time constant injected by vite.config `define` — the query-cache buster
// (lib/persist.ts). A fresh build changes it, discarding a stale-shaped persisted cache.
declare const __BUILD_ID__: string
