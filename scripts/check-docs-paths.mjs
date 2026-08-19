#!/usr/bin/env node

// The docs site deploys only when its sources change (see `deploy-docs` in
// .github/workflows/ci.yml). This asserts that the path filter driving that
// decision covers every source the site is actually generated from.
//
// It exists because the failure mode is silent. A page whose source falls outside
// the filter does not break the build and does not fail a test — it simply stops
// being republished, and the site quietly serves a stale copy until somebody
// notices the wording is out of date. Nothing else in the repo would catch that.
//
// The manifest is the authority: apps/docs/docs-manifest.mjs decides which files
// become pages, and this reads the filter out of the composite action and checks
// the filter covers it. Add a page sourced from a new location and this fails
// until .github/actions/changed learns about it.

import { readFileSync } from "node:fs"
import { docsHome, docsPages } from "../apps/docs/docs-manifest.mjs"

const ACTION = ".github/actions/changed/action.yml"
const action = readFileSync(ACTION, "utf8")

// The `docs=true` case arm, e.g.
//   apps/docs/* | SECURITY.md | examples/README.md | \
//     packages/cli/README.md | packages/mcp/README.md)
//     docs=true
//
// Found by walking BACK from the LAST `docs=true` to the nearest `case "$path" in`.
// Both halves of that matter: a forward regex matches the first case block in the
// file (the action classifies four things and they share an opener), and the FIRST
// `docs=true` is the no-range fallback that turns every filter on, not this arm.
const marker = action.lastIndexOf("docs=true")
const opener = marker === -1 ? -1 : action.lastIndexOf('case "$path" in', marker)
const armText =
  opener === -1
    ? null
    : action
        .slice(opener + 'case "$path" in'.length, marker)
        .trim()
        .replace(/\)$/, "")

if (!armText) {
  console.error(`docs paths: could not find the docs=true case arm in ${ACTION}.`)
  console.error("If that filter moved, this check has to move with it — it is the only")
  console.error("thing standing between a renamed source and a silently stale docs site.")
  process.exit(1)
}

const patterns = armText
  .replace(/\\\s*\n/g, " ")
  .split("|")
  .map((p) => p.trim())
  .filter(Boolean)

/** shell `case` globbing, restricted to the two forms this filter uses. */
const covers = (pattern, path) =>
  pattern.endsWith("/*") ? path.startsWith(pattern.slice(0, -1)) : pattern === path

const sources = [...new Set([...docsPages.map((page) => page.source), docsHome?.source])].filter(
  Boolean,
)

// The lockfile is not a manifest source and would not be caught by the sweep below,
// but the docs site is BUILT with astro, @astrojs/mdx, pagefind and wrangler — all
// pinned there. A version bump changes the rendered output or how it ships while
// touching no content file, so omitting it means an upgrade sits undeployed until
// somebody happens to edit a page. Measured: 27 commits in 30 days moved the
// lockfile without touching any docs source.
const TOOLCHAIN = ["pnpm-lock.yaml"]

const uncovered = [...sources, ...TOOLCHAIN].filter(
  (source) => !patterns.some((p) => covers(p, source)),
)
if (uncovered.length) {
  console.error("docs paths: these docs sources are NOT covered by the deploy filter:")
  for (const source of uncovered) console.error(`  ${source}`)
  console.error(`\nAdd them to the docs=true case arm in ${ACTION}, or the docs site will`)
  console.error("stop redeploying when they change — silently.")
  console.error(`\nfilter patterns: ${patterns.join(" | ")}`)
  process.exit(1)
}

// The reverse direction is advisory, not an error: a pattern covering more than the
// manifest strictly needs (the whole of apps/docs, say, which holds the Astro app
// and its assets as well as content) is deliberate and correct.
console.log(
  `docs paths: ${sources.length} docs sources + ${TOOLCHAIN.length} toolchain input all covered by ${patterns.length} filter patterns`,
)
