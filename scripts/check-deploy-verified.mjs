#!/usr/bin/env node
// A production deploy must PROVE it shipped, not imply it.
//
// The failure this exists for is quiet and was expensive. `wrangler deploy` hit a transient
// Cloudflare error, the previous worker kept serving, and the pipeline around it looked
// healthy enough that the fix was believed live for two hours while its symptoms were debugged
// against code that was never running. Liveness could not have caught it: /healthz answers 200
// from whichever worker is up, including the old one.
//
// Three properties close that, and this asserts all three stay wired:
//
//   1. the deploy stamps the commit into the worker (`--var BUILD_SHA:`)
//   2. the post-deploy check COMPARES that stamp to the commit being deployed
//   3. neither step is allowed to fail quietly (`continue-on-error`)
//
// Any one of them alone is defeatable: stamping without comparing proves nothing, comparing
// without stamping compares "dev" forever, and continue-on-error makes both advisory.
import { readFileSync } from "node:fs"

const FILE = ".github/workflows/ci.yml"
const yml = readFileSync(FILE, "utf8")
const fail = (msg) => {
  console.error(`check-deploy-verified: ${msg}`)
  process.exitCode = 1
}

// The deploy job's region: from `- name: Deploy worker` to the end of the file is enough —
// Verify prod follows it, and nothing after them re-deploys.
const from = yml.indexOf("- name: Deploy worker")
const region = from === -1 ? "" : yml.slice(from)

if (from === -1) fail(`no "Deploy worker" step in ${FILE} — has the deploy moved?`)

if (!/--var\s+BUILD_SHA:/.test(region))
  fail(
    'the deploy does not stamp BUILD_SHA. Without it /healthz reports "dev" forever and the ' +
      "version check below can never distinguish a fresh worker from a stale one.",
  )

if (!/"\$GITHUB_SHA"|\$\{\{\s*github\.sha\s*\}\}/.test(region))
  fail("nothing in the deploy path references the commit being deployed")

// The comparison itself: a version check that reads the build but never tests it is decoration.
if (!/\$build"?\s*=\s*"?\$GITHUB_SHA|"\$build"\s*=\s*"\$GITHUB_SHA"/.test(region))
  fail(
    "the post-deploy check does not compare the served build to $GITHUB_SHA — it is a liveness " +
      "smoke again, which cannot tell a fresh worker from the one already serving.",
  )

if (/continue-on-error:\s*true/.test(region))
  fail("continue-on-error in the deploy path makes a failed deploy report success")

// ---------------------------------------------------------------------------------------
// The health endpoints the check above depends on must actually REACH the worker.
//
// `not_found_handling = "single-page-application"` means the asset handler answers any path
// not listed in run_worker_first with 200 + index.html, BEFORE the worker is consulted. So a
// missing entry does not 404 — it serves HTML with a success status, which a probe reads as
// healthy. /readyz shipped that way: it returned 200 text/html no matter what the database was
// doing, making a readiness probe that could never report unready.
const OPERATIONAL = ["/healthz", "/readyz"]
// apps/api/wrangler.toml, NOT a root one: this is the file `pnpm --filter @derive/api exec
// wrangler deploy` reads, the file CI injects binding ids into, and the file
// scripts/preview-config.mjs derives a preview from. A byte-identical copy briefly existed at
// the repo root and was read twice as if it were live — a fix applied there changed nothing.
const WRANGLER = "apps/api/wrangler.toml"
const toml = readFileSync(WRANGLER, "utf8")
const workerFirst = /run_worker_first\s*=\s*\[([^\]]*)\]/.exec(toml)?.[1] ?? ""
for (const route of OPERATIONAL) {
  if (!workerFirst.includes(`"${route}"`))
    fail(
      `${route} is not in ${WRANGLER} run_worker_first — the asset handler will serve the SPA shell for it ` +
        `with a 200, so any probe pointed at it reports healthy unconditionally.`,
    )
}

if (process.exitCode) {
  console.error(`\nSee ${FILE}. Fix the wiring rather than this check.`)
} else {
  console.log(
    "check-deploy-verified: ok — deploy stamps the commit, the check asserts it, " +
      `and ${OPERATIONAL.join(" + ")} reach the worker`,
  )
}
