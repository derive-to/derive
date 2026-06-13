// Prepare the SPA build output (apps/web/dist/client) for Cloudflare Workers Static
// Assets, so the worker can serve the whole app same-origin with the API:
//
//  - copy `_shell.html` -> `index.html`: Workers' `not_found_handling =
//    "single-page-application"` serves `/index.html` for any non-asset route, which is
//    how client-side routing (/login, /settings, ...) survives a hard refresh.
//  - remove the Pages-style `_redirects` (`/*  /_shell.html  200`): on Workers that
//    catch-all also rewrites `/assets/*`, so JS/CSS get served as HTML and the SPA never
//    boots. `not_found_handling` replaces it correctly (real files win over the fallback).
//
// Run via `pnpm --filter @dock/api build:web` (which builds apps/web first). Idempotent.
import { copyFileSync, existsSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const dist = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist/client")
const shell = join(dist, "_shell.html")
if (!existsSync(shell)) {
  process.stderr.write(`missing ${shell} — run the web build first\n`)
  process.exit(1)
}
copyFileSync(shell, join(dist, "index.html"))
const redirects = join(dist, "_redirects")
if (existsSync(redirects)) rmSync(redirects)
process.stdout.write(`prepped edge assets in ${dist} (index.html written, _redirects removed)\n`)
