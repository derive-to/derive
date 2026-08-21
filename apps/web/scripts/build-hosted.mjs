#!/usr/bin/env node
// derive.to's own public surface: the marketing pages, the trust files, the
// sitemap and the robots overlay. Copied into the build here rather than living in
// public/, where Vite would fold it into EVERY build — including the Docker image a
// self-host runs. A self-hosted Derive should serve its operator's front door, not
// ours, and the runtime is already built for the pages being absent: marketing.ts
// hands `/`, `/pricing`, `/privacy` and `/examples` back to the application when
// the build ships no site/ directory.
//
// Runs only from the hosted build (`pnpm --filter @derive/api build:web`), which is
// what CI deploys. A plain `pnpm --filter @derive/web build` is the application on
// its own. In development Vite serves the same directory from vite.config.ts.
import { cpSync, existsSync } from "node:fs"
import { dirname, join, sep } from "node:path"
import { fileURLToPath } from "node:url"

const APP = join(dirname(fileURLToPath(import.meta.url)), "..")
const HOSTED = join(APP, "hosted")
const DIST = join(APP, "dist/client")

const fail = (message) => {
  process.stderr.write(`build-hosted: ${message}\n`)
  process.exit(1)
}

if (!existsSync(DIST)) fail(`missing ${DIST} — run the web build first`)
if (!existsSync(HOSTED)) fail(`missing ${HOSTED}`)

// posts/ is the blog's markdown source, rendered into dist/client/blog by
// build-blog.mjs immediately after this; it is not itself a published file.
const POSTS = join(HOSTED, "posts")
// robots.txt exists in both trees on purpose: every deployment ships the generic one
// from public/, and derive.to's copy (which adds the sitemap) overlays it here.
cpSync(HOSTED, DIST, {
  recursive: true,
  filter: (src) => src !== POSTS && !src.startsWith(`${POSTS}${sep}`),
})

// The landing page is the front door. Shipping without it would quietly serve the
// application shell to signed-out visitors at `/`, and the first party to notice
// would be a crawler, so fail the build instead.
for (const required of ["site/index.html", "site/shell.css", "robots.txt", "sitemap.xml"])
  if (!existsSync(join(DIST, required))) fail(`assembled build is missing ${required}`)

process.stdout.write("build-hosted: derive.to public surface -> dist/client\n")
