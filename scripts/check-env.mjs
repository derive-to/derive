#!/usr/bin/env node
// Config-completeness guardrail. `.env.example` must be the FULL, HONEST list of the
// server's configuration: every process-env var the API server actually reads must be
// documented there (no silent, undiscoverable setting), and every var documented there
// must actually be read (no phantom setting like the old REDIS_URL, which did nothing).
// Both directions fail here so `.env.example` can't drift from the code. Runs in the CI
// gate. Escape hatch for a genuinely non-user-facing var: add it to NON_CONFIG below.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const API_SRC = join(process.cwd(), "apps/api/src")
const ENV_EXAMPLE = join(process.cwd(), ".env.example")

// Vars the server reads that are NOT user-facing self-host config, so they don't belong
// in `.env.example`. Each must be justified — this list is the deliberate exceptions.
const NON_CONFIG = new Set([
  // Stamped onto the worker by `wrangler deploy --var` in CI so /healthz can report which
  // commit is serving. Never operator-set: a hand-run deploy leaves it unset and /healthz
  // honestly reports "dev". The self-host equivalent, DERIVE_BUILD_SHA, IS operator-facing
  // and is documented in .env.example.
  "BUILD_SHA",
  // Cloudflare Workers bindings (configured in wrangler.toml, not env)
  "DB",
  "ROOMS",
  "HYPERDRIVE",
  "BUCKET",
  "ASSETS",
  "SITE",
  "SEND_EMAIL",
  "WEBHOOK_OUTBOX",
  "PREVIEW_RENDERER",
  "BROWSER",
  // Injected only by scripts/preview-config.mjs for same-repo PR deployments. These
  // are deployment-isolation invariants, not self-host operator configuration.
  "DERIVE_EXPORTS_ONLY",
  "DERIVE_QA_EMAIL_CAPTURE",
  // Hosted R2 behavior. Self-hosted object storage uses the S3 or filesystem adapter.
  "DERIVE_R2_MULTIPART",
  // Hosted automation runs (experimental): the per-run container + the dispatch queue.
  // Declared in wrangler.toml [[containers]] / [[queues]], never as env.
  "RUN_CONTAINER",
  "RUN_QUEUE",
  "AI",
  "RL_AUTH",
  "RL_INVITE",
  "RL_ACCESS_REQUEST",
  "RL_WRITE",
  "RL_PUBLISH",
  "RL_COMMENT",
  "RL_STRICT",
  // Injected by the managed host / runtime, never set by the operator
  "RENDER_EXTERNAL_URL",
  "RAILWAY_PUBLIC_DOMAIN",
  "FLY_APP_NAME",
  "NODE_ENV",
])

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full)
  }
  return out
}

// Every UPPER_SNAKE env var the API source reads, across the three access styles:
//   process.env.X   ·   env.X (worker Env + config param)   ·   env("X") (auth-config)
const readVars = new Set()
const ENV_ACCESS = /(?:process\.env|env)\.([A-Z][A-Z0-9_]+)|env\(["']([A-Z][A-Z0-9_]+)["']\)/g
for (const file of walk(API_SRC)) {
  const src = readFileSync(file, "utf8")
  for (const m of src.matchAll(ENV_ACCESS)) readVars.add(m[1] ?? m[2])
}

// Every var documented in .env.example (set or commented: `FOO=` / `# FOO=`).
const documented = new Set()
for (const line of readFileSync(ENV_EXAMPLE, "utf8").split("\n")) {
  const m = line.match(/^#?\s*([A-Z][A-Z0-9_]+)=/)
  if (m) documented.add(m[1])
}

const userConfig = [...readVars].filter((v) => !NON_CONFIG.has(v))
const undocumented = userConfig.filter((v) => !documented.has(v)).sort()
const phantom = [...documented].filter((v) => !readVars.has(v)).sort()

const problems = []
for (const v of undocumented)
  problems.push(
    `  ${v}: read by the server but not in .env.example — document it (or add to NON_CONFIG if it's a binding/platform var)`,
  )
for (const v of phantom)
  problems.push(
    `  ${v}: documented in .env.example but read nowhere in apps/api/src — remove it, or it's a promise the code doesn't keep`,
  )

if (problems.length) {
  console.error(`check-env: .env.example is out of sync with the code:\n${problems.join("\n")}`)
  process.exit(1)
}
console.log(
  `check-env: ok — .env.example documents all ${userConfig.length} server config vars, none phantom`,
)
