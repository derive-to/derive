#!/usr/bin/env node
// Public language is part of the product contract. Licensing, anonymous access, agent
// compatibility, and the required verification gate have precise implementations; a broad
// marketing edit must not silently promise something different. Keep this check narrow and
// evidence-backed. If a new claim is genuinely true, update the implementation and this contract
// together rather than adding an unreviewed string exception.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, extname, join, relative, resolve } from "node:path"

const ROOT = process.cwd()
const TEXT_EXTENSIONS = new Set([".html", ".json", ".md", ".mdx", ".txt", ".xml"])

const walkText = (directory) => {
  const files = []
  for (const name of readdirSync(join(ROOT, directory))) {
    const path = join(directory, name)
    const stat = statSync(join(ROOT, path))
    if (stat.isDirectory()) files.push(...walkText(path))
    else if (TEXT_EXTENSIONS.has(extname(name))) files.push(path)
  }
  return files
}

const claimFiles = new Set([
  "README.md",
  "SECURITY.md",
  "SUPPORT.md",
  "package.json",
  "server.json",
  ...walkText("apps/docs/content"),
  ...walkText("apps/web/public"),
  "apps/docs/astro.config.mjs",
  "apps/docs/docs-manifest.mjs",
  "apps/web/src/pages/login.tsx",
  "apps/web/src/pages/roadmap.tsx",
  "apps/web/src/pages/settings/billing-plans.ts",
  "apps/web/src/components/shared/connect-agent.tsx",
  "apps/web/src/components/showcase/showcase.tsx",
  "apps/api/src/routes/agent-discovery.ts",
  "apps/api/src/routes/embeds.ts",
  "apps/api/src/routes/system.ts",
  "packages/cli/README.md",
  "packages/cli/package.json",
  "packages/mcp/README.md",
  "packages/mcp/package.json",
])

const failures = []
const fail = (message) => failures.push(message)
const read = (path) => readFileSync(join(ROOT, path), "utf8")

const forbidden = [
  {
    pattern: /\bopen[- ]source\b/i,
    reason: "Derive is Fair Source today; reserve open-source comparisons for LICENSING.md",
  },
  {
    pattern: /people outside your team never need an account/i,
    reason: "anonymous users may view but must sign in before commenting or editing",
  },
  {
    pattern: /every agent speaks MCP/i,
    reason: "MCP support applies to compatible clients, not every agent",
  },
  {
    pattern: /(?:connect|give|paste (?:this )?into) any agent/i,
    reason: "do not make universal agent-compatibility claims",
  },
  {
    pattern: /whatever your team runs/i,
    reason: "name tested clients or say MCP-compatible",
  },
  {
    pattern: /FIG\. 01 — a live artifact/i,
    reason: "the homepage animation is a representative product walkthrough, not a live artifact",
  },
  {
    pattern: /Reviewers are never seats/i,
    reason: "approvers are editors; only readers and commenters are always free",
  },
  {
    pattern: /A published URL never breaks/i,
    reason: "only billing behavior supports this promise; scope the heading to billing",
  },
  {
    pattern: /The self-hostable home for AI artifacts/i,
    reason: "the public category is review and approval for agent-made work",
  },
]

for (const path of claimFiles) {
  if (!existsSync(join(ROOT, path))) {
    fail(`missing public-claim surface ${path}`)
    continue
  }
  const lines = read(path).split("\n")
  for (const { pattern, reason } of forbidden) {
    for (const [index, line] of lines.entries()) {
      if (pattern.test(line)) fail(`${path}:${index + 1}: ${reason}\n  ${line.trim()}`)
    }
  }
}

const requireText = (path, text, reason) => {
  if (!read(path).includes(text)) fail(`${path} must contain ${JSON.stringify(text)} — ${reason}`)
}

requireText("LICENSING.md", "Strictly speaking, no.", "state the current license status plainly")
requireText("SECURITY.md", "Anonymous callers are always read-only", "match effectiveRole")
requireText("apps/web/public/site/index.html", "Fair Source and self-hostable", "accurate metadata")
requireText(
  "apps/web/public/site/index.html",
  "commenting or editing requires sign-in",
  "match the anonymous read-only invariant",
)
requireText("apps/web/src/pages/login.tsx", "Fair Source.", "login must not claim OSI status")
requireText(
  "apps/web/src/components/shared/connect-agent.tsx",
  "Fair Source review-and-approval tool",
  "self-host prompt must describe the current license",
)
requireText(
  "apps/web/public/.well-known/security.txt",
  "server is source available",
  "security contact must describe the current license",
)
requireText(
  "apps/web/public/site/index.html",
  "product walkthrough · the review loop",
  "label representative proof honestly",
)
requireText("README.md", 'href="https://docs.derive.to"', "link to the documentation site")
requireText("CONTRIBUTING.md", "pnpm verify", "use the exact CI check gate")
requireText(
  ".github/PULL_REQUEST_TEMPLATE.md",
  "`pnpm verify` passes",
  "use the exact CI check gate",
)

const pullRequestTemplate = read(".github/PULL_REQUEST_TEMPLATE.md")
for (const stale of [/\[ \].*pnpm typecheck/, /\[ \].*biome ci/, /\[ \].*pnpm test(?:\s|`)/])
  if (stale.test(pullRequestTemplate))
    fail(".github/PULL_REQUEST_TEMPLATE.md must have one pnpm verify checkbox, not partial gates")

for (const path of [
  "docs/README.md",
  "docs/GROWTH-MEASUREMENT.md",
  "SUPPORT.md",
  "MAINTAINERS.md",
  "packages/cli/README.md",
  "packages/mcp/README.md",
  "examples/README.md",
  "examples/launch-page/index.html",
  "examples/research-brief/report.md",
  "examples/living-status/status.md",
  "apps/web/public/404.html",
  "apps/web/public/robots.txt",
  "apps/docs/astro.config.mjs",
  "apps/docs/docs-manifest.mjs",
  "apps/docs/wrangler.toml",
  "apps/docs/src/pages/404.astro",
  "apps/docs/scripts/sync-content.mjs",
  "apps/docs/scripts/check-built.mjs",
])
  if (!existsSync(join(ROOT, path))) fail(`required public documentation is missing: ${path}`)

for (const path of ["docs/README.md", "examples/README.md"]) {
  const markdown = read(path)
  for (const match of markdown.matchAll(/\]\(([^)#]+\.md)(?:#[^)]+)?\)/g)) {
    const target = match[1]
    if (/^https?:/.test(target)) continue
    const absolute = resolve(ROOT, dirname(path), target)
    if (!existsSync(absolute))
      fail(`${path} links to missing local file ${relative(ROOT, absolute)}`)
  }
}

requireText(
  "apps/web/public/sitemap.xml",
  "<loc>https://derive.to/examples</loc>",
  "index public examples",
)
if (read("apps/web/public/sitemap.xml").includes("https://derive.to/guides"))
  fail("derive.to sitemap must not index the permanent /guides redirect")
if (existsSync(join(ROOT, "apps/web/public/site/guides.html")))
  fail("the retired derive.to guides page must not compete with docs.derive.to")

for (const path of [
  "apps/web/public/site/index.html",
  "apps/web/public/site/pricing.html",
  "apps/web/public/site/examples.html",
]) {
  requireText(path, "data-derive-source", "name at least one measurable intent surface")
  if (read(path).includes("/site/attribution.js"))
    fail(`${path} must not load the retired signup-attribution cookie script`)
}
if (existsSync(join(ROOT, "apps/web/public/site/attribution.js")))
  fail("the retired signup-attribution cookie script must stay deleted")
for (const path of [
  "apps/web/public/site/index.html",
  "apps/web/public/site/pricing.html",
  "apps/web/public/site/privacy.html",
  "apps/web/public/site/examples.html",
])
  requireText(path, "https://docs.derive.to/", "send readers to the canonical docs host")
requireText(
  "apps/api/src/routes/marketing.ts",
  'c.redirect("https://docs.derive.to/", 308)',
  "keep the former guides URL as a permanent redirect",
)
requireText(
  "apps/docs/wrangler.toml",
  'pattern = "docs.derive.to"',
  "deploy docs on their own hostname",
)
requireText(
  "apps/docs/wrangler.toml",
  'not_found_handling = "404-page"',
  "return real documentation 404s",
)
requireText(
  ".github/workflows/ci.yml",
  "deploy-docs:",
  "ship documentation independently from the hosted product",
)
requireText(
  "apps/web/public/404.html",
  'name="robots" content="noindex, nofollow"',
  "keep error pages out of search",
)

if (failures.length) {
  console.error("check-public-claims: public contract drifted\n")
  for (const message of failures) console.error(`  ✖ ${message}`)
  console.error(
    "\nFix the claim or its implementation. Do not add an exception for language the product cannot prove.",
  )
  process.exit(1)
}

console.log(
  `check-public-claims: ok — ${claimFiles.size} public surfaces match license, access, compatibility, proof, docs, and gate contracts`,
)
