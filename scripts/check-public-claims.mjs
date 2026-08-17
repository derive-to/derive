#!/usr/bin/env node
// Public language is a product contract. Keep this guard limited to claims whose
// implementation cannot be inferred from a successful docs build or route test.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join } from "node:path"

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

const publicCopyFiles = new Set([
  "package.json",
  "README.md",
  "SECURITY.md",
  ".github/SUPPORT.md",
  ...walkText("apps/docs/content"),
  ...walkText("apps/web/public"),
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
  "packages/cli/skills/derive/SKILL.md",
  "packages/cli/skills/derive/agents/openai.yaml",
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
    pattern: /turn agent output into approved work/i,
    reason: "formal approval is an optional control, not every artifact's promised outcome",
    positioning: true,
  },
  {
    pattern: /review and approval for (?:work made by ai agents|agent-made work)/i,
    reason: "describe the full artifact workspace rather than one optional workflow",
    positioning: true,
  },
  {
    pattern: /publish\s*(?:→|->)\s*review\s*(?:→|->)\s*revise\s*(?:→|->)\s*approve/i,
    reason: "do not present one formal review sequence as the path for every artifact",
    positioning: true,
  },
  {
    pattern: /every artifact runs the same loop/i,
    reason: "private, shared, recurring, and formal-review artifacts are all valid",
    positioning: true,
  },
  {
    pattern: /the loop is what you pay for/i,
    reason: "pricing pays for editor seats, not one required workflow",
    positioning: true,
  },
]

const licensingPath = "apps/docs/content/reference/licensing.md"

// The public marketing site keeps its own editorial voice. Positioning wording and
// em-dash punctuation are set per page there, so those two checks describe the docs,
// README, and in-app surfaces instead. Every license, access, and agent claim below
// still applies to the marketing pages.
const marketingSite = new Set([
  "apps/web/public/security.html",
  ...walkText("apps/web/public/site"),
])

// Public prose should read like the rest of the product: short sentences and calm
// punctuation. Comments and internal engineering docs are outside this copy check.
const publicProseFiles = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "README.md",
  "SECURITY.md",
  ...walkText("apps/api/src/skills"),
  ...walkText("apps/docs/content"),
  ...walkText("examples"),
  "apps/web/public/llms.txt",
  "apps/web/public/llms-full.txt",
  "packages/mcp/SKILL.md",
])

const publicProseDashOffset = (path, text) => {
  if (!path.endsWith(".html")) return text.indexOf("—")

  let inHtmlComment = false
  let inBlockComment = false
  for (let offset = 0; offset < text.length; offset += 1) {
    if (inHtmlComment) {
      if (text.startsWith("-->", offset)) {
        inHtmlComment = false
        offset += 2
      }
      continue
    }
    if (inBlockComment) {
      if (text.startsWith("*/", offset)) {
        inBlockComment = false
        offset += 1
      }
      continue
    }
    if (text.startsWith("<!--", offset)) {
      inHtmlComment = true
      offset += 3
      continue
    }
    if (text.startsWith("/*", offset)) {
      inBlockComment = true
      offset += 1
      continue
    }
    if (text[offset] === "—") return offset
  }
  return -1
}

for (const path of publicProseFiles) {
  if (!existsSync(join(ROOT, path))) {
    fail(`missing public-prose surface ${path}`)
    continue
  }
  const text = read(path)
  const offset = publicProseDashOffset(path, text)
  if (offset === -1) continue
  const line = text.slice(0, offset).split("\n").length
  fail(`${path}:${line}: public prose uses an em dash; use a period, colon, or parentheses`)
}

for (const path of publicCopyFiles) {
  if (!existsSync(join(ROOT, path))) {
    fail(`missing public-copy surface ${path}`)
    continue
  }
  for (const [index, line] of read(path).split("\n").entries()) {
    for (const { pattern, reason, positioning } of forbidden) {
      if (path === licensingPath && pattern.source === "\\bopen[- ]source\\b") continue
      if (positioning && marketingSite.has(path)) continue
      if (pattern.test(line)) fail(`${path}:${index + 1}: ${reason}\n  ${line.trim()}`)
    }
  }
}

const requireText = (path, expected, reason) => {
  if (!read(path).includes(expected))
    fail(`${path} must contain ${JSON.stringify(expected)} — ${reason}`)
}

// License, access, agent compatibility, and the human decision boundary are
// promises a copy edit must not broaden.
requireText(
  licensingPath,
  "Not under the Open Source Initiative definition.",
  "state the current license status plainly",
)
requireText("SECURITY.md", "Anonymous callers are always read-only", "match effectiveRole")
requireText("apps/web/public/site/index.html", "Fair Source and self-hostable", "accurate metadata")
requireText(
  "apps/web/public/site/index.html",
  "commenting or editing requires sign-in",
  "match the anonymous read-only invariant",
)
requireText("apps/web/src/pages/login.tsx", "Fair Source.", "do not claim OSI status")
requireText(
  "apps/web/src/components/shared/connect-agent.tsx",
  "Fair Source workspace for agent-made artifacts",
  "describe the current license",
)
requireText(
  "apps/web/public/.well-known/security.txt",
  "server is source available",
  "describe the current license",
)
requireText("README.md", "a compatible agent over MCP", "scope agent compatibility")
requireText("README.md", "a proposal a human approves", "preserve human approval")
for (const path of ["README.md", "apps/docs/content/index.mdx"])
  requireText(
    path,
    "keep, share, and improve",
    "lead with the durable artifact promise rather than a required review outcome",
  )
requireText(
  "packages/cli/skills/derive/SKILL.md",
  "Do not request review merely because an artifact exists.",
  "keep formal review optional in the canonical agent guidance",
)

// Keep one canonical documentation origin and one deterministic contributor gate.
requireText("README.md", 'href="https://docs.derive.to"', "link to the documentation site")
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
requireText("apps/docs/wrangler.toml", 'pattern = "docs.derive.to"', "deploy on the docs host")
requireText("CONTRIBUTING.md", "pnpm verify", "use the exact CI check gate")
requireText(
  ".github/PULL_REQUEST_TEMPLATE.md",
  "`pnpm verify` passes",
  "use the exact CI check gate",
)

// Signup attribution is an explicit account handoff, not ambient click tracking.
// Pin the small supported set so public copy cannot promise a token that a route
// silently drops, and static interest controls cannot masquerade as measurement.
for (const [path, marker] of [
  ["apps/web/public/site/index.html", 'href="/login?src=nav_signin"'],
  ["apps/web/public/site/examples.html", 'href="/login?src=examples_signin"'],
  ["apps/web/public/site/index.html", 'data-derive-source="homepage_waitlist"'],
  ["apps/web/public/site/pricing.html", 'data-derive-source="pricing_waitlist"'],
  ["apps/web/src/components/shared/public-frame.tsx", 'signupSourceSearch("public_frame"'],
  ["apps/web/src/pages/artifact/public-viewer.tsx", 'signupSourceSearch("make_your_own"'],
  ["apps/web/src/pages/artifact/public-viewer.tsx", 'signupSourceSearch("comment_wall"'],
  ["apps/web/src/pages/artifact/public-viewer.tsx", 'signupSourceSearch("badge"'],
  ["docs/GROWTH-MEASUREMENT.md", "/login?signup=1&src=hn-launch&landing=/"],
])
  requireText(path, marker, "keep attribution on an explicit account-creation handoff")

const attributionSurfaces = [
  "docs/GROWTH-MEASUREMENT.md",
  "apps/docs/astro.config.mjs",
  "apps/docs/content/index.mdx",
  "apps/web/public/site/index.html",
  "apps/web/public/site/pricing.html",
  "apps/web/public/site/examples.html",
]
for (const token of [
  "hero_agent_prompt",
  "homepage_example",
  "copy_skill",
  "copy_mcp",
  "copy_draft",
  "pricing_cta",
  "docs_nav",
  "docs_home",
  "docs_hosted",
  "official_examples",
])
  for (const path of attributionSurfaces)
    if (read(path).includes(token))
      fail(`${path} contains inert attribution token ${token}; only account handoffs are measured`)

for (const path of attributionSurfaces.filter((path) => path.endsWith(".html")))
  for (const [index, line] of read(path).split("\n").entries())
    if (line.includes("data-derive-source") && !line.includes("<form data-waitlist"))
      fail(`${path}:${index + 1}: data-derive-source belongs only on the beta-access form`)

const pullRequestTemplate = read(".github/PULL_REQUEST_TEMPLATE.md")
for (const stale of [/\[ \].*pnpm typecheck/, /\[ \].*biome ci/, /\[ \].*pnpm test(?:\s|`)/])
  if (stale.test(pullRequestTemplate))
    fail(".github/PULL_REQUEST_TEMPLATE.md must use pnpm verify, not partial gates")

if (failures.length) {
  console.error("check-public-claims: public contract drifted\n")
  for (const message of failures) console.error(`  ✖ ${message}`)
  console.error("\nFix the claim or its implementation; do not weaken the contract.")
  process.exit(1)
}

console.log(
  `check-public-claims: ok — ${publicCopyFiles.size} surfaces preserve positioning, license, access, agent, approval, docs, and gate claims`,
)
