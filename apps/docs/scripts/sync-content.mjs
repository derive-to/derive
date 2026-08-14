#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, extname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { docsPages } from "../docs-manifest.mjs"

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const REPO_ROOT = resolve(APP_ROOT, "../..")
const CONTENT_ROOT = join(APP_ROOT, "src/content/docs")
const PUBLIC_ROOT = join(APP_ROOT, "public")
const GENERATED_MARKER =
  "<!-- Generated from the canonical repository source; do not edit here. -->"
const GENERATED_MDX_MARKER =
  "{/* Generated from the canonical repository source; do not edit here. */}"

const sourceToPage = new Map(docsPages.map((page) => [resolve(REPO_ROOT, page.source), page]))

const withinRepo = (path) => path === REPO_ROOT || path.startsWith(`${REPO_ROOT}${sep}`)
const webPath = (page, hash = "") => `/${page.slug === "index" ? "" : `${page.slug}/`}${hash}`

const rewrittenTarget = (source, rawTarget) => {
  const wrapped = rawTarget.startsWith("<") && rawTarget.endsWith(">")
  const target = wrapped ? rawTarget.slice(1, -1) : rawTarget
  if (
    !target ||
    target.startsWith("#") ||
    target.startsWith("/") ||
    target.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(target)
  )
    return rawTarget

  const hashAt = target.indexOf("#")
  const pathPart = hashAt === -1 ? target : target.slice(0, hashAt)
  const hash = hashAt === -1 ? "" : target.slice(hashAt)
  const absolute = resolve(dirname(source), decodeURIComponent(pathPart))
  if (!withinRepo(absolute) || !existsSync(absolute)) return rawTarget

  const page = sourceToPage.get(absolute)
  if (page) return webPath(page, hash)

  const repoPath = relative(REPO_ROOT, absolute).split(sep).join("/")
  const kind = statSync(absolute).isDirectory() ? "tree" : "blob"
  return `https://github.com/derive-to/derive/${kind}/main/${repoPath}${hash}`
}

const rewriteLinks = (body, source) => {
  let rewritten = body.replace(
    /(!?\[[^\]]*\]\()(<[^>]+>|[^)\s]+)([^)]*\))/g,
    (_, open, target, close) => {
      return `${open}${rewrittenTarget(source, target)}${close}`
    },
  )

  // Canonical GitHub links sometimes appear in package READMEs because those files
  // also ship to npm. On the docs build, keep readers inside the documentation site.
  for (const [absolute, page] of sourceToPage) {
    const repoPath = relative(REPO_ROOT, absolute).split(sep).join("/")
    const github = `https://github.com/derive-to/derive/blob/main/${repoPath}`
    const internal = webPath(page)
    rewritten = rewritten.replaceAll(github, internal === "/" ? internal : internal.slice(0, -1))
  }
  return rewritten
}

const lastUpdated = (source) => {
  try {
    return execFileSync("git", ["log", "-1", "--format=%cI", "--", relative(REPO_ROOT, source)], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return ""
  }
}

const yamlString = (value) => JSON.stringify(value)

const renderPage = (page) => {
  const source = resolve(REPO_ROOT, page.source)
  if (!withinRepo(source) || !existsSync(source))
    throw new Error(`missing docs source: ${page.source}`)
  let body = readFileSync(source, "utf8").replace(/\r\n/g, "\n")
  if (page.stripHeading !== false) body = body.replace(/^#\s+[^\n]+\n+/, "")
  body = rewriteLinks(body, source)
    .replace(/^```caddyfile$/gm, "```text")
    .trim()
  const updated = lastUpdated(source)
  const frontmatter = [
    "---",
    `title: ${yamlString(page.title)}`,
    `description: ${yamlString(page.description)}`,
    `editUrl: ${yamlString(`https://github.com/derive-to/derive/edit/main/${page.source}`)}`,
    updated ? `lastUpdated: ${updated}` : "lastUpdated: false",
    "---",
  ].join("\n")
  const marker = extname(page.source) === ".mdx" ? GENERATED_MDX_MARKER : GENERATED_MARKER
  return `${frontmatter}\n\n${marker}\n\n${body}\n`
}

const generatedFiles = (directory) => {
  if (!existsSync(directory)) return []
  const files = []
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) files.push(...generatedFiles(path))
    else files.push(path)
  }
  return files
}

const slugs = new Set()
const sources = new Set()
for (const page of docsPages) {
  if (!/^(?:index|[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*)$/.test(page.slug))
    throw new Error(`invalid docs slug: ${page.slug}`)
  if (slugs.has(page.slug)) throw new Error(`duplicate docs slug: ${page.slug}`)
  if (sources.has(page.source)) throw new Error(`duplicate docs source: ${page.source}`)
  // `docs/` is the repository's maintainer/design record. Public concepts that
  // explain the same capability live under apps/docs/content and are deliberately
  // rewritten for users. This path boundary keeps migrations, rollout switches,
  // and incident notes out of both the public site and llms-full.txt.
  if (page.source === "docs" || page.source.startsWith("docs/"))
    throw new Error(`maintainer-only source cannot enter public docs: ${page.source}`)
  slugs.add(page.slug)
  sources.add(page.source)
}

mkdirSync(CONTENT_ROOT, { recursive: true })
const expected = new Set()
for (const page of docsPages) {
  const extension = extname(page.source) === ".mdx" ? ".mdx" : ".md"
  const output = join(CONTENT_ROOT, `${page.slug}${extension}`)
  expected.add(output)
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, renderPage(page))
}

// Remove only files carrying our ownership marker. An unexpected hand-authored
// file fails closed instead of being deleted by a generator.
for (const path of generatedFiles(CONTENT_ROOT)) {
  if (expected.has(path)) continue
  const content = readFileSync(path, "utf8")
  if (!content.includes(GENERATED_MARKER) && !content.includes(GENERATED_MDX_MARKER))
    throw new Error(
      `unexpected non-generated file in generated docs tree: ${relative(APP_ROOT, path)}`,
    )
  unlinkSync(path)
}

mkdirSync(join(PUBLIC_ROOT, "fonts"), { recursive: true })
copyFileSync(join(REPO_ROOT, "apps/web/public/brand/favicon.svg"), join(PUBLIC_ROOT, "favicon.svg"))
copyFileSync(
  join(REPO_ROOT, "apps/web/public/site/geist.woff2"),
  join(PUBLIC_ROOT, "fonts/geist.woff2"),
)
copyFileSync(
  join(REPO_ROOT, "apps/web/public/site/geist-mono.woff2"),
  join(PUBLIC_ROOT, "fonts/geist-mono.woff2"),
)

writeFileSync(
  join(PUBLIC_ROOT, "robots.txt"),
  "User-agent: *\nAllow: /\n\nSitemap: https://docs.derive.to/sitemap-index.xml\n",
)

// Cloudflare applies this file directly to static-asset responses. Keep the
// policy beside the generator so every clean build gets the same controls and
// hashed Astro assets receive immutable caching without making HTML stale.
writeFileSync(
  join(PUBLIC_ROOT, "_headers"),
  `/*
  Content-Security-Policy: default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; upgrade-insecure-requests
  Cross-Origin-Opener-Policy: same-origin
  Permissions-Policy: accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), publickey-credentials-get=(), usb=()
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  X-Permitted-Cross-Domain-Policies: none

/_astro/*
  Cache-Control: public, max-age=31536000, immutable

/fonts/*
  Cache-Control: public, max-age=604800, stale-while-revalidate=86400

https://:preview.:subdomain.workers.dev/*
  X-Robots-Tag: noindex, nofollow
`,
)

const indexLines = [
  "# Derive documentation",
  "",
  "> Review and approval for work made by AI agents.",
  "",
  "Canonical documentation: https://docs.derive.to/",
  "OpenAPI: https://derive.to/openapi.json",
  "Agent skill: https://derive.to/skill.md",
  "",
  "## Pages",
  "",
  ...docsPages.map(
    (page) => `- [${page.title}](https://docs.derive.to${webPath(page)}) — ${page.description}`,
  ),
  "",
]
writeFileSync(join(PUBLIC_ROOT, "llms.txt"), indexLines.join("\n"))

const fullText = docsPages.flatMap((page) => [
  `# ${page.title}`,
  "",
  `Source: https://docs.derive.to${webPath(page)}`,
  "",
  renderPage(page)
    .replace(/^---\n[\s\S]*?\n---\n\n/, "")
    .replace(`${GENERATED_MARKER}\n\n`, "")
    .replace(`${GENERATED_MDX_MARKER}\n\n`, ""),
])
writeFileSync(join(PUBLIC_ROOT, "llms-full.txt"), fullText.join("\n"))

console.log(
  `docs-sync: ${docsPages.length} canonical sources → ${relative(REPO_ROOT, CONTENT_ROOT)}`,
)
