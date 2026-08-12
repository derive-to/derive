#!/usr/bin/env node
// The quick start is an executable interface, not marketing copy. Keep the two supported paths
// complete and keep their commands aligned with the Compose and release files that implement them.
import { existsSync, readFileSync } from "node:fs"

const QUICKSTART = "QUICKSTART.md"
const README = "README.md"
const DEPLOY = "DEPLOY.md"
const COMPOSE = "deploy/compose.yml"
const BUILD_COMPOSE = "deploy/compose.build.yml"
const RELEASE = ".github/workflows/release-images.yml"
const CI = ".github/workflows/ci.yml"
const SMOKE = "scripts/test-selfhost-quickstart.sh"
const SMOKE_CLIENT = "scripts/selfhost-smoke-client.mjs"

const read = (path) => readFileSync(path, "utf8")
const quickstart = read(QUICKSTART)
const readme = read(README)
const deploy = read(DEPLOY)
const compose = read(COMPOSE)
const buildCompose = read(BUILD_COMPOSE)
const release = read(RELEASE)
const ci = read(CI)
const smoke = read(SMOKE)
const smokeClient = read(SMOKE_CLIENT)

const failures = []
const fail = (message) => failures.push(message)
const requireText = (source, text, where) => {
  if (!source.includes(text)) fail(`${where} must contain ${JSON.stringify(text)}`)
}

const section = (heading, nextHeading) => {
  const start = quickstart.indexOf(heading)
  if (start === -1) {
    fail(`${QUICKSTART} is missing ${heading}`)
    return ""
  }
  const end = nextHeading ? quickstart.indexOf(nextHeading, start + heading.length) : -1
  return quickstart.slice(start, end === -1 ? undefined : end)
}

const requireOrder = (source, labels, where) => {
  let cursor = -1
  for (const label of labels) {
    const at = source.indexOf(label, cursor + 1)
    if (at === -1) {
      fail(`${where} must contain ${JSON.stringify(label)} after the preceding setup step`)
      return
    }
    cursor = at
  }
}

const releasePath = section(
  "## Install a published release (recommended)",
  "## Build the current checkout",
)
const sourcePath = section("## Build the current checkout", "## If startup fails")

for (const [label, body, envFile] of [
  ["release path", releasePath, ".env"],
  ["source path", sourcePath, "deploy/.env"],
]) {
  requireText(body, `--env-file ${envFile}`, `${QUICKSTART} ${label}`)
  requireText(body, "config --quiet", `${QUICKSTART} ${label}`)
  requireText(body, "bootstrap-operator", `${QUICKSTART} ${label}`)
  requireText(body, "up -d --wait --wait-timeout 120", `${QUICKSTART} ${label}`)
  requireText(body, "/readyz", `${QUICKSTART} ${label}`)
  requireText(body, " backup ", `${QUICKSTART} ${label}`)
  requireText(body, "verify-backup", `${QUICKSTART} ${label}`)
  requireOrder(
    body,
    ["config --quiet", "bootstrap-operator", "up -d --wait", "/readyz", "verify-backup"],
    `${QUICKSTART} ${label}`,
  )
}

for (const variable of [
  "DERIVE_IMAGE",
  "BASE_URL",
  "DERIVE_AUTH_SECRET",
  "DERIVE_SIGNUP_MODE",
  "DERIVE_BIND_ADDRESS",
])
  requireText(quickstart, variable, QUICKSTART)

for (const capacity of ["4 GB of free Docker storage", "10 GB free"])
  requireText(quickstart, capacity, `${QUICKSTART} capacity requirements`)

for (const target of ["CONTRIBUTING.md", "DEPLOY.md"])
  requireText(quickstart, target, `${QUICKSTART} path chooser`)

for (const asset of ["compose.yml", "selfhost.env.example"]) {
  requireText(quickstart, `releases/latest/download/${asset}`, `${QUICKSTART} release download`)
  requireText(release, `release/${asset}`, `${RELEASE} attached install files`)
}

requireText(release, "DERIVE_IMAGE=ghcr.io/derive-to/derive@$DIGEST", RELEASE)
requireText(compose, "${DERIVE_IMAGE:?", COMPOSE)
requireText(compose, "http://127.0.0.1:8080/readyz", COMPOSE)
requireText(buildCompose, "image: derive:local", BUILD_COMPOSE)

for (const workflow of [
  [CI, ci],
  [RELEASE, release],
])
  requireText(workflow[1], SMOKE, `${workflow[0]} self-host integration gate`)

for (const operation of [
  "bootstrap-operator",
  "up -d --wait --wait-timeout 120",
  "backup /backups/quickstart-smoke",
  "verify-backup /backups/quickstart-smoke",
  "restore-backup /backups/quickstart-smoke",
])
  requireText(smoke, operation, SMOKE)

for (const boundary of [
  "/api/auth/sign-in/email",
  "/api/auth/sign-up/email",
  "SIGNUP_NOT_ALLOWED",
  "/v1/artifacts",
])
  requireText(smokeClient, boundary, SMOKE_CLIENT)

requireText(readme, "[self-hosting quick start](QUICKSTART.md)", README)
requireText(deploy, "[QUICKSTART.md](QUICKSTART.md)", DEPLOY)
if (readme.includes("docker compose -f deploy/compose.yml up -d"))
  fail(
    `${README} contains the old incomplete start command; new users need image selection, ` +
      "operator bootstrap, readiness, and backup",
  )

// Catch renamed or moved local Markdown targets before a reader finds the dead link.
for (const match of quickstart.matchAll(/\]\(([^)]+\.md)(?:#[^)]+)?\)/g)) {
  const target = match[1]
  if (!target.startsWith("http") && !existsSync(target))
    fail(`${QUICKSTART} links to missing local file ${target}`)
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`check-selfhost-quickstart: ${failure}`)
  process.exitCode = 1
} else {
  console.log(
    "check-selfhost-quickstart: ok — docs and CI cover bootstrap, auth, publish, backup, and restore",
  )
}
