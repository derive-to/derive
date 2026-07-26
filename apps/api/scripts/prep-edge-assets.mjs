// Prepare the SPA build output (apps/web/dist/client) for Cloudflare Workers Static
// Assets, so the worker can serve the whole app same-origin with the API:
//
//  - copy `_shell.html` -> `index.html`: Workers' `not_found_handling =
//    "single-page-application"` serves `/index.html` for any non-asset route, which is
//    how client-side routing (/login, /settings, ...) survives a hard refresh.
//  - remove the Pages-style `_redirects` (`/*  /_shell.html  200`): on Workers that
//    catch-all also rewrites `/assets/*`, so JS/CSS get served as HTML and the SPA never
//    boots. `not_found_handling` replaces it correctly (real files win over the fallback).
//  - write a `_headers` file so Vite's content-hashed `/assets/*` get a one-year
//    immutable Cache-Control. Static Assets defaults to `max-age=0, must-revalidate`
//    (right for the shell, which changes every deploy) but that re-validates every
//    fingerprinted chunk on each load. The hash in the filename already busts the
//    cache on change, so these are safe to pin. `_headers` only applies to assets the
//    static layer serves directly — `/assets/*` is not in run_worker_first, so it does.
//
// Run via `pnpm --filter @derive/api build:web` (which builds apps/web first). Idempotent.
import { copyFileSync, existsSync, rmSync, writeFileSync } from "node:fs"
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
// `_headers` for everything the static layer serves (the SPA shell + /assets/*).
// The worker sets these on its own routes (/v1, /api, /raw, /a, …), but the SPA
// shell and assets are served directly by Static Assets and bypass that middleware
// — so without this the app at `/`, `/login`, `/settings`, … shipped no security
// headers and was framable (clickjacking). We set only clickjacking + sniffing +
// transport hardening; deliberately NO script-src/default-src CSP, so the SPA's
// module scripts, inline theme-boot, and Google Fonts keep working untouched.
writeFileSync(
  join(dist, "_headers"),
  [
    "/*",
    "  X-Frame-Options: DENY",
    "  Content-Security-Policy: frame-ancestors 'none'",
    "  X-Content-Type-Options: nosniff",
    "  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload",
    "  Referrer-Policy: strict-origin-when-cross-origin",
    "",
    "/assets/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
  ].join("\n"),
)
process.stdout.write(
  `prepped edge assets in ${dist} (index.html written, _redirects removed, _headers written)\n`,
)
