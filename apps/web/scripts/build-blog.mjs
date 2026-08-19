#!/usr/bin/env node
// The blog. Posts are markdown files in apps/web/content/blog; this renders them
// into the web build (apps/web/dist/client/blog) as plain static pages, so the blog
// ships and is served exactly like the rest of the marketing site: files on
// Cloudflare Static Assets, no route, no session, no database.
//
//   content/blog/2026-08-19-title.md  ->  /blog/title      (dist/client/blog/title.html)
//                                         /blog            (the index)
//                                         /blog/rss.xml    (the feed)
//
// The date prefix on the filename is the publication order and is stripped from the
// URL. Front matter is a plain `key: value` block: `title`, `description` and `date`
// are required; `author`, `image`, `slug` and `draft` are optional.
//
// Why generate rather than hand-write each post like the other public pages: the
// head, the navigation and the footer are identical on every post, and the blog is
// the one part of the site that grows a file at a time. Why not a site framework:
// the posts have to read as the SAME publication as index.html and pricing.html,
// which means the hand-authored shell in public/site, not a theme.
//
// Runs at the end of the web build (apps/web package.json). Idempotent: it clears
// its own output directory and rewrites the sitemap between its own markers.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { marked } from "marked"

const APP = join(dirname(fileURLToPath(import.meta.url)), "..")
const CONTENT = join(APP, "content/blog")
const DIST = join(APP, "dist/client")
const OUT = join(DIST, "blog")
const SITE = "https://derive.to"
const DEFAULT_IMAGE = "/site/og-artifacts.png"

const fail = (message) => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

if (!existsSync(DIST)) fail(`missing ${DIST} — run the web build first`)

/* Posts ------------------------------------------------------------------- */

const FILENAME = /^(\d{4}-\d{2}-\d{2})-([a-z0-9][a-z0-9-]*)\.md$/

const parseFrontMatter = (raw, file) => {
  const block = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!block) fail(`${file}: no front matter (the file must open with a --- block)`)
  const meta = {}
  for (const line of block[1].split("\n")) {
    if (!line.trim()) continue
    const colon = line.indexOf(":")
    if (colon === -1) fail(`${file}: front matter line is not "key: value": ${line}`)
    const value = line.slice(colon + 1).trim()
    const quoted = value.length > 1 && (value.at(0) === '"' || value.at(0) === "'")
    meta[line.slice(0, colon).trim()] = quoted ? value.slice(1, -1) : value
  }
  return { meta, body: raw.slice(block[0].length) }
}

// Heading ids so a section of a long post can be linked to directly. Done on the
// rendered HTML rather than through a marked renderer: the output is the contract
// here, and a regex over it does not move when marked changes its renderer API.
const withHeadingIds = (html) =>
  html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (whole, level, inner) => {
    const id = inner
      .replace(/<[^>]*>/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
    return id ? `<h${level} id="${id}">${inner}</h${level}>` : whole
  })

const readPosts = () => {
  if (!existsSync(CONTENT)) return []
  const posts = []
  for (const file of readdirSync(CONTENT).sort()) {
    if (!file.endsWith(".md")) continue
    const name = FILENAME.exec(file)
    if (!name) fail(`${file}: name a post YYYY-MM-DD-slug.md (lowercase slug)`)
    const { meta, body } = parseFrontMatter(readFileSync(join(CONTENT, file), "utf8"), file)
    if (meta.draft === "true") continue
    for (const key of ["title", "description"])
      if (!meta[key]) fail(`${file}: front matter needs a ${key}`)
    const date = meta.date ?? name[1]
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`${file}: date must be YYYY-MM-DD`)
    const slug = meta.slug ?? name[2]
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) fail(`${file}: slug must be lowercase and unpunctuated`)
    posts.push({
      slug,
      date,
      title: meta.title,
      description: meta.description,
      author: meta.author ?? "",
      image: meta.image ?? DEFAULT_IMAGE,
      url: `${SITE}/blog/${slug}`,
      html: withHeadingIds(marked.parse(body, { async: false, gfm: true })),
    })
  }
  const slugs = new Set()
  for (const post of posts) {
    if (slugs.has(post.slug)) fail(`two posts claim /blog/${post.slug}`)
    slugs.add(post.slug)
  }
  // Newest first everywhere the reader sees a list.
  return posts.sort((a, b) => (a.date < b.date ? 1 : -1))
}

/* Rendering --------------------------------------------------------------- */

const esc = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const MONTHS =
  "January February March April May June July August September October November December"
const readable = (date) => {
  const [year, month, day] = date.split("-")
  return `${MONTHS.split(" ")[Number(month) - 1]} ${Number(day)}, ${year}`
}

// The shell every public page shares: the theme boot that runs before first paint,
// the fonts, shell.css (tokens, container, navigation) and this section's own CSS.
const page = ({ type, title, description, canonical, image, schema, body }) => `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="${type}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${SITE}${image}">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="${canonical}">
<link rel="alternate" type="application/rss+xml" title="Derive" href="${SITE}/blog/rss.xml">
<script type="application/ld+json">
${JSON.stringify(schema, null, 2)}
</script>
<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/brand/favicon.png" type="image/png">
<script>
/* theme boot: set the class before first paint (the choice lives in localStorage) */
(function(){
  var m = null; try { m = localStorage.getItem('derive-theme'); } catch (e) {}
  if (m !== 'light' && m !== 'system') m = 'dark';
  var light = m === 'light' || (m === 'system' && matchMedia('(prefers-color-scheme: light)').matches);
  var c = document.documentElement.classList;
  c.toggle('light', light); c.toggle('dark', !light);
})();
</script>
<link rel="stylesheet" href="/site/shell.css">
<link rel="stylesheet" href="/site/blog.css">
<script src="/site/shell.js" defer></script>
</head>
<body>

<a class="skip-link" href="#main-content">Skip to content</a>

<nav class="site-nav" aria-label="Primary">
  <div class="wrap site-nav__inner">
    <a class="site-nav__brand" href="/">
      <img class="wm-dark" src="/brand/wordmark-light.svg" alt="Derive">
      <img class="wm-light" src="/brand/wordmark-dark.svg" alt="Derive">
    </a>
    <div class="site-nav__links">
      <a href="https://docs.derive.to/">Docs</a>
      <a href="/examples">Examples</a>
      <a href="/blog" aria-current="page">Blog</a>
      <a href="/pricing">Pricing</a>
      <a href="https://github.com/derive-to/derive">GitHub</a>
      <button class="site-nav__theme" type="button" data-theme-toggle aria-label="Theme">
        <svg class="i-sun" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="3" stroke="currentColor" stroke-width="1.3"/><path d="M7 .8v1.7M7 11.5v1.7M.8 7h1.7M11.5 7h1.7M2.6 2.6l1.2 1.2M10.2 10.2l1.2 1.2M11.4 2.6l-1.2 1.2M3.8 10.2l-1.2 1.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        <svg class="i-moon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M11.8 8.6A5.2 5.2 0 1 1 5.4 2.2a4.2 4.2 0 0 0 6.4 6.4Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
        <svg class="i-sys" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="5.4" stroke="currentColor" stroke-width="1.3"/><path d="M7 1.6v10.8A5.4 5.4 0 0 0 7 1.6Z" fill="currentColor"/></svg>
      </button>
      <a class="site-nav__signin" href="/login?src=nav_signin">Sign in to Beta <span class="arr" aria-hidden="true">&rarr;</span></a>
    </div>
  </div>
</nav>

<main id="main-content" tabindex="-1">
${body}
</main>

<footer>
  <div class="foot-inner">
    <span class="fm">
      <svg width="15" height="15" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path d="M3 15V3h5.2a6 6 0 0 1 0 12H3Z" stroke="currentColor" stroke-width="1.6"/>
        <path d="M11.5 15 15 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
      Derive
    </span>
    <div class="foot-links">
      <a href="/">Home</a>
      <a href="/blog">Blog</a>
      <a href="/pricing">Pricing</a>
      <a href="/privacy">Privacy</a>
      <a href="/security">Security</a>
      <a href="https://github.com/derive-to/derive">GitHub</a>
      <a href="/login?src=nav_signin">Log in</a>
    </div>
    <span class="license">Fair source &middot; FSL-1.1-ALv2 &rarr; Apache-2.0</span>
  </div>
</footer>

</body>
</html>
`

const postPage = (post, newer) =>
  page({
    type: "article",
    title: `${post.title} | Derive`,
    description: post.description,
    canonical: post.url,
    image: post.image,
    schema: {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: post.title,
      description: post.description,
      datePublished: post.date,
      url: post.url,
      image: `${SITE}${post.image}`,
      ...(post.author ? { author: { "@type": "Person", name: post.author } } : {}),
      publisher: { "@id": `${SITE}/#organization` },
      isPartOf: { "@id": `${SITE}/#website` },
    },
    body: `
<article class="post wrap wrap-prose">
  <header class="post-head">
    <div class="eyebrow"><a href="/blog">Blog</a></div>
    <h1>${esc(post.title)}</h1>
    <p class="lede">${esc(post.description)}</p>
    <p class="post-meta">
      <time datetime="${post.date}">${readable(post.date)}</time>${
        post.author ? ` <span aria-hidden="true">&middot;</span> ${esc(post.author)}` : ""
      }
    </p>
  </header>
  <div class="prose">
${post.html.trim()}
  </div>
  <nav class="post-foot" aria-label="More posts">
    <a href="/blog">All posts</a>${
      newer ? `\n    <a class="next" href="/blog/${newer.slug}">Newer: ${esc(newer.title)}</a>` : ""
    }
  </nav>
</article>
`,
  })

const indexPage = (posts) =>
  page({
    type: "website",
    title: "Blog | Derive",
    description: "Notes from the people building Derive: what shipped, and why it works that way.",
    canonical: `${SITE}/blog`,
    image: DEFAULT_IMAGE,
    schema: {
      "@context": "https://schema.org",
      "@type": "Blog",
      name: "Derive",
      url: `${SITE}/blog`,
      description: "Notes from the people building Derive.",
      publisher: { "@id": `${SITE}/#organization` },
      isPartOf: { "@id": `${SITE}/#website` },
    },
    body: `
<header class="head wrap wrap-prose">
  <div class="eyebrow">Blog</div>
  <h1>What we shipped, and why it works that way.</h1>
  <p class="lede">Notes from the people building Derive. Fewer announcements, more of the reasoning behind the product.</p>
</header>

<section class="wrap wrap-prose">
  ${
    posts.length === 0
      ? `<p class="empty">The first post is being written.</p>`
      : `<ol class="posts">
${posts
  .map(
    (post) => `    <li>
      <a href="/blog/${post.slug}">
        <time datetime="${post.date}">${readable(post.date)}</time>
        <h2>${esc(post.title)}</h2>
        <p>${esc(post.description)}</p>
      </a>
    </li>`,
  )
  .join("\n")}
  </ol>`
  }
</section>
`,
  })

// RSS, because a blog that cannot be followed is a page. Dates are stamped at 09:00
// UTC: the feed needs a time, the post only ever claims a day.
const feed = (posts) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Derive</title>
    <link>${SITE}/blog</link>
    <description>Notes from the people building Derive.</description>
    <language>en</language>
    <atom:link href="${SITE}/blog/rss.xml" rel="self" type="application/rss+xml"/>
${posts
  .map(
    (post) => `    <item>
      <title>${esc(post.title)}</title>
      <link>${post.url}</link>
      <guid isPermaLink="true">${post.url}</guid>
      <pubDate>${new Date(`${post.date}T09:00:00Z`).toUTCString()}</pubDate>
      <description>${esc(post.description)}</description>
    </item>`,
  )
  .join("\n")}
  </channel>
</rss>
`

/* Sitemap ----------------------------------------------------------------- */

// The blog is the only part of the public surface with a changing URL list, so its
// entries are written into the built sitemap rather than maintained by hand in
// public/sitemap.xml. Between markers, so re-running replaces instead of appending.
const START = "  <!-- blog:start -->"
const END = "  <!-- blog:end -->"

const updateSitemap = (posts) => {
  const path = join(DIST, "sitemap.xml")
  if (!existsSync(path)) {
    process.stderr.write("build-blog: no dist sitemap.xml, blog URLs not listed\n")
    return
  }
  const existing = readFileSync(path, "utf8").replace(new RegExp(`${START}[\\s\\S]*?${END}\n`), "")
  const entries = [
    `  <url>\n    <loc>${SITE}/blog</loc>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n  </url>`,
    ...posts.map(
      (post) =>
        `  <url>\n    <loc>${post.url}</loc>\n    <lastmod>${post.date}</lastmod>\n    <changefreq>yearly</changefreq>\n    <priority>0.6</priority>\n  </url>`,
    ),
  ]
  writeFileSync(
    path,
    existing.replace("</urlset>", `${START}\n${entries.join("\n")}\n${END}\n</urlset>`),
  )
}

/* Build ------------------------------------------------------------------- */

const posts = readPosts()
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
posts.forEach((post, index) => {
  writeFileSync(join(OUT, `${post.slug}.html`), postPage(post, posts[index - 1]))
})
writeFileSync(join(OUT, "index.html"), indexPage(posts))
writeFileSync(join(OUT, "rss.xml"), feed(posts))
updateSitemap(posts)
process.stdout.write(`build-blog: ${posts.length} post${posts.length === 1 ? "" : "s"} -> /blog\n`)
