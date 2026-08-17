#!/usr/bin/env node
// The public pages are static on purpose. This guard keeps their repeated shell
// accessible and consistent without adding a framework or runtime templating.
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()
const pages = [
  "apps/web/public/site/index.html",
  "apps/web/public/site/examples.html",
  "apps/web/public/site/pricing.html",
  "apps/web/public/site/privacy.html",
  "apps/web/public/security.html",
]
const expectedNav = [
  "https://docs.derive.to/",
  "/examples",
  "/pricing",
  "https://github.com/derive-to/derive",
]
const expectedFooter = [
  "https://docs.derive.to/",
  "/examples",
  "/pricing",
  "https://github.com/derive-to/derive",
  "https://docs.derive.to/reference/licensing/",
  "/privacy",
  "/security",
]

const failures = []
const fail = (path, message) => failures.push(`${path}: ${message}`)
const hrefs = (html) => [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((match) => match[1])
const one = (html, pattern) => (html.match(pattern) ?? []).length === 1

for (const path of pages) {
  const html = readFileSync(join(ROOT, path), "utf8")

  if (!one(html, /<link rel="stylesheet" href="\/site\/site\.css">/g))
    fail(path, "must load the shared site stylesheet exactly once")
  if (!one(html, /<script src="\/site\/site\.js"><\/script>/g))
    fail(path, "must load the shared site behavior exactly once")
  if (/<style[\s>]/i.test(html)) fail(path, "must not add page-specific inline styles")
  if (/\son[a-z]+\s*=/i.test(html)) fail(path, "must not add inline event handlers")

  if (!one(html, /<nav class="site-nav" data-site-nav aria-label="Main navigation">/g))
    fail(path, "must expose one canonical main navigation")
  if (!/<a class="wordmark" href="\/" aria-label="Homepage">/.test(html))
    fail(path, "wordmark must link to the homepage with an accessible name")
  if (!/<details class="mobile-nav">/.test(html)) fail(path, "must include the mobile menu")
  if (!/<a class="skip-link" href="#main-content">Skip to content<\/a>/.test(html))
    fail(path, "must include the canonical skip link")
  if (!/<main id="main-content" tabindex="-1">/.test(html))
    fail(path, "main content must be the skip-link target")
  if (!one(html, /<footer class="site-footer">/g)) fail(path, "must include one canonical footer")

  const desktop = html.match(/<div class="desktop-nav">([\s\S]*?)<\/div>/)?.[1]
  if (!desktop) fail(path, "is missing desktop navigation links")
  else if (JSON.stringify(hrefs(desktop)) !== JSON.stringify(expectedNav))
    fail(path, `desktop navigation must keep this order: ${expectedNav.join(", ")}`)

  const mobile = html.match(/<div class="mobile-nav-panel">([\s\S]*?)<\/div>/)?.[1]
  if (!mobile) fail(path, "is missing mobile navigation links")
  else if (JSON.stringify(hrefs(mobile).slice(0, 4)) !== JSON.stringify(expectedNav))
    fail(path, `mobile navigation must keep this order: ${expectedNav.join(", ")}`)

  const footer = html.match(/<footer class="site-footer">([\s\S]*?)<\/footer>/)?.[1]
  if (footer) {
    const publicLinks = hrefs(footer).filter((href) => !href.startsWith("/login"))
    if (JSON.stringify(publicLinks) !== JSON.stringify(expectedFooter))
      fail(path, `footer links must keep this order: ${expectedFooter.join(", ")}`)
  }

  for (const marker of [
    '<meta name="description" content="',
    '<meta property="og:title" content="',
    '<meta property="og:description" content="',
    '<link rel="canonical" href="',
  ])
    if (!html.includes(marker)) fail(path, `is missing metadata marker ${marker}`)
}

if (failures.length) {
  console.error("check-public-site-shell: public pages drifted\n")
  for (const failure of failures) console.error(`  ✖ ${failure}`)
  console.error("\nUse the shared shell and keep repeated navigation in the same relative order.")
  process.exit(1)
}

console.log(`check-public-site-shell: ok — ${pages.length} pages share one accessible shell`)
