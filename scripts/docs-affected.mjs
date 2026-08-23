#!/usr/bin/env node

// Answer one question: can these changed paths affect the documentation site?
//
//   node scripts/docs-affected.mjs <nul-separated-changed-paths-file>   -> true|false
//   node scripts/docs-affected.mjs --all                               -> true
//
// ONE SOURCE OF TRUTH, deliberately. The docs site is not built from apps/docs
// alone: docs-manifest.mjs maps its pages to canonical sources scattered across
// the repo, currently including SECURITY.md and three package READMEs. An earlier
// version of this duplicated that list as a shell `case` arm inside the composite
// action, with a second script that regex-extracted the arm back out of the YAML
// to check the two still agreed. That is a lot of machinery to keep one list in
// sync with itself. Reading the manifest is the same answer without the copy.
//
// The failure mode this protects against is silent: a page whose source falls
// outside the filter does not break the build and does not fail a test, it just
// stops being republished while the site serves a stale copy.

import { readFileSync } from "node:fs"
import { docsHome, docsPages } from "../apps/docs/docs-manifest.mjs"

const arg = process.argv[2]
if (!arg) {
  console.error("usage: docs-affected.mjs <changed-paths-file>|--all")
  process.exit(2)
}

// No diff range (a manual dispatch, a first push) means we cannot know: assume
// affected rather than silently skip a deploy.
if (arg === "--all") {
  console.log("true")
  process.exit(0)
}

/** Every file the built site is derived from. */
const sources = new Set([...docsPages.map((page) => page.source), docsHome?.source].filter(Boolean))

const affects = (path) =>
  // The Astro app itself: pages, components, config, the manifest, public assets.
  path.startsWith("apps/docs/") ||
  // A canonical source the manifest turns into a page.
  sources.has(path) ||
  // The brand files the docs build copies in (fonts, favicon): a swap there
  // otherwise skips the redeploy and the docs silently keep the old bytes.
  path.startsWith("apps/web/public/brand/") ||
  // The toolchain. astro, @astrojs/mdx, pagefind and wrangler are pinned in the
  // lockfile and each changes the rendered output or how it ships, so a bump has
  // to redeploy even though it touches no content file.
  path === "pnpm-lock.yaml"

let changed
try {
  changed = readFileSync(arg, "utf8").split("\0").filter(Boolean)
} catch (error) {
  console.error(`docs-affected: cannot read ${arg}: ${error.message}`)
  process.exit(2)
}

console.log(changed.some(affects) ? "true" : "false")
