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

if (process.exitCode) {
  console.error(`\nSee ${FILE}. Fix the wiring rather than this check.`)
} else {
  console.log("check-deploy-verified: ok — deploy stamps the commit and the check asserts it")
}
