#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { dirname, extname, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { docsPages } from "../docs-manifest.mjs"

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const DIST = join(APP_ROOT, "dist")
const failures = []
const fail = (message) => failures.push(message)

for (const page of docsPages)
  if (page.source === "docs" || page.source.startsWith("docs/"))
    fail(`maintainer-only source entered the public manifest: ${page.source}`)

const filesUnder = (directory) => {
  if (!existsSync(directory)) return []
  const files = []
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) files.push(...filesUnder(path))
    else files.push(path)
  }
  return files
}

const required = [
  "index.html",
  "404.html",
  "robots.txt",
  "_headers",
  "llms.txt",
  "llms-full.txt",
  "sitemap-index.xml",
  "pagefind/pagefind.js",
]
for (const path of required) if (!existsSync(join(DIST, path))) fail(`missing build output ${path}`)

for (const page of docsPages) {
  const path = page.slug === "index" ? "index.html" : `${page.slug}/index.html`
  if (!existsSync(join(DIST, path))) fail(`manifest page did not build: ${path}`)
}

const htmlFiles = filesUnder(DIST).filter((path) => extname(path) === ".html")
for (const path of htmlFiles) {
  const html = readFileSync(path, "utf8")
  const label = relative(DIST, path)
  if (label !== "404.html" && !html.includes('rel="canonical" href="https://docs.derive.to/'))
    fail(`${label} has no docs.derive.to canonical URL`)
  if (label === "404.html" && !/name="robots" content="noindex/.test(html))
    fail("404.html must be noindex")
  if (/href="\/[^"]+\.md(?:#|\?|")/.test(html))
    fail(`${label} contains an internal source Markdown link`)

  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    const href = match[1]
    if (!href || href.startsWith("#") || href.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(href))
      continue
    const pathname = href.split(/[?#]/, 1)[0]
    if (!pathname?.startsWith("/")) continue
    const target = pathname.endsWith("/")
      ? join(DIST, pathname, "index.html")
      : extname(pathname)
        ? join(DIST, pathname)
        : join(DIST, pathname, "index.html")
    if (!existsSync(target)) fail(`${label} links to missing internal target ${href}`)
  }
}

const llmsFull = readFileSync(join(DIST, "llms-full.txt"), "utf8")
for (const maintainerPhrase of [
  "Migration (from production",
  "Blast radius (implementation order",
  "Turning it on for real (Cloudflare)",
  "uncomment the four blocks",
])
  if (llmsFull.includes(maintainerPhrase))
    fail(`llms-full.txt contains maintainer-only material: ${maintainerPhrase}`)

// An index that merely exists can still be useless. Exercise the generated
// browser search API over HTTP (Node fetch deliberately does not serve file://)
// and pin the handful of high-intent queries a new user is most likely to try.
const searchContracts = [
  ["self-host", "/self-hosting/quickstart/"],
  ["MCP", "/agents/mcp/"],
  ["access", "/concepts/access/"],
  ["custom domain", "/self-hosting/configuration/"],
]
const server = createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://docs.test").pathname)
    const target = resolve(DIST, `.${pathname}`)
    if (target !== DIST && !target.startsWith(`${DIST}/`)) {
      response.writeHead(403).end()
      return
    }
    if (!existsSync(target) || statSync(target).isDirectory()) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200).end(readFileSync(target))
  } catch {
    response.writeHead(500).end()
  }
})
try {
  await new Promise((accept, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", accept)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("search audit did not bind TCP")
  const pagefind = await import(pathToFileURL(join(DIST, "pagefind/pagefind.js")).href)
  await pagefind.options({ basePath: `http://127.0.0.1:${address.port}/pagefind/` })
  await pagefind.init()
  for (const [query, expectedUrl] of searchContracts) {
    const result = await pagefind.search(query)
    const top = await Promise.all(result.results.slice(0, 5).map((item) => item.data()))
    if (!top.some((item) => new URL(item.url, "https://docs.derive.to").pathname === expectedUrl))
      fail(
        `search for ${JSON.stringify(query)} did not rank ${expectedUrl} in its first five results`,
      )
  }
  await pagefind.destroy()
} catch (error) {
  fail(`Pagefind relevance audit failed: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await new Promise((accept) => server.close(accept))
}

const wrangler = readFileSync(join(APP_ROOT, "wrangler.toml"), "utf8")
if (!wrangler.includes('pattern = "docs.derive.to"')) fail("wrangler.toml lacks docs custom domain")
if (!wrangler.includes('not_found_handling = "404-page"'))
  fail("wrangler.toml must return a real 404 for unknown documentation paths")
if (!wrangler.includes("workers_dev = false") || !wrangler.includes("preview_urls = false"))
  fail("production docs must not expose an indexable workers.dev duplicate")

const headers = readFileSync(join(DIST, "_headers"), "utf8")
for (const requiredHeader of [
  "Content-Security-Policy:",
  "frame-ancestors 'none'",
  "X-Content-Type-Options: nosniff",
  "Referrer-Policy: strict-origin-when-cross-origin",
  "Cache-Control: public, max-age=31536000, immutable",
  "X-Robots-Tag: noindex, nofollow",
])
  if (!headers.includes(requiredHeader)) fail(`_headers lacks ${requiredHeader}`)

if (failures.length) {
  console.error("docs-build: documentation contract failed\n")
  for (const message of failures) console.error(`  ✖ ${message}`)
  process.exit(1)
}

console.log(`docs-build: ok — ${docsPages.length} pages, local search, canonicals, and real 404s`)
