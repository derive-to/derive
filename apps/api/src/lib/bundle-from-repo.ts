// Bundle-aware sync: when a synced HTML file references local assets in the repo
// (a stylesheet, script, image, font), we mirror it as a Dock *bundle* — the
// entry HTML plus those assets — instead of a lone file that renders unstyled.
// Bundles are served as mini static sites (manifest.files lookup), so relative
// refs resolve natively with no rewriting; we only have to gather the right files
// and preserve their relative layout.
//
// This module is pure path/string logic over the repo tree: it never fetches blob
// bytes itself (the caller passes a `fetchText` so we can read stylesheets and
// follow their @import/url() refs), so it's trivially unit-testable.

/** POSIX dirname: "a/b/c.html" → "a/b"; a root-level path → "". */
const dirname = (p: string): string => {
  const i = p.lastIndexOf("/")
  return i < 0 ? "" : p.slice(0, i)
}

/**
 * Resolve a reference against a base directory, POSIX-style, collapsing `.`/`..`.
 * A leading "/" is treated as repo-root-relative (mirrors how the bundle server
 * rewrites root-absolute URLs). Returns null when the ref escapes the repo root.
 * Query/hash fragments are stripped first.
 */
export const resolveRef = (baseDir: string, ref: string): string | null => {
  const clean = ref.split(/[?#]/)[0]?.trim()
  if (!clean) return null
  const fromRoot = clean.startsWith("/")
  const segs = (fromRoot ? [] : baseDir ? baseDir.split("/") : []).concat(clean.split("/"))
  const out: string[] = []
  for (const s of segs) {
    if (s === "" || s === ".") continue
    if (s === "..") {
      if (out.length === 0) return null // escapes the repo root
      out.pop()
    } else out.push(s)
  }
  return out.length ? out.join("/") : null
}

/** A reference we can actually pull from the repo: relative, not a URL/data/anchor. */
export const isLocalRef = (ref: string): boolean => {
  const r = ref.trim()
  if (!r || r.startsWith("#") || r.startsWith("//")) return false
  // Any scheme (http:, https:, data:, mailto:, tel:, blob:, …) is external.
  if (/^[a-z][a-z0-9+.-]*:/i.test(r)) return false
  return true
}

/**
 * Local asset references in an HTML document. We pull what a page needs to RENDER
 * — stylesheets, scripts, images, media, fonts via <link> — but deliberately NOT
 * `<a href>` page links, so a bundle is one page's assets, never a crawl of the
 * whole site.
 */
export const htmlAssetRefs = (html: string): string[] => {
  // Pull an attribute's value from the given tags, tolerating quoted ("x"/'x') AND
  // unquoted (=x) values — both are valid HTML and appear in minified/hand-written
  // pages. The three alternatives capture into groups 1/2/3.
  const attrVals = (tags: string, attr: string): string[] => {
    const re = new RegExp(
      `<(?:${tags})\\b[^>]*?\\b${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s">]+))`,
      "gi",
    )
    const out: string[] = []
    for (const m of html.matchAll(re)) {
      const v = m[1] ?? m[2] ?? m[3]
      if (v) out.push(v)
    }
    return out
  }
  const refs: string[] = [
    // <link href> (stylesheets, icons, preload) — but NOT <a href> page links.
    ...attrVals("link", "href"),
    ...attrVals("script|img|source|video|audio|track|embed|iframe", "src"),
  ]
  // srcset: comma-separated "url descriptor" — keep each candidate's url.
  for (const set of attrVals("img|source", "srcset")) {
    for (const cand of set.split(",")) {
      const url = cand.trim().split(/\s+/)[0]
      if (url) refs.push(url)
    }
  }
  // CSS in <style> blocks or style="" attributes (url(), @import).
  refs.push(...cssAssetRefs(html))
  return refs
}

/** url(...) and @import targets in a CSS (or a chunk of HTML with inline CSS). */
export const cssAssetRefs = (css: string): string[] => {
  const refs: string[] = []
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) if (m[1]) refs.push(m[1])
  for (const m of css.matchAll(/@import\s+["']([^"']+)["']/gi)) if (m[1]) refs.push(m[1])
  return refs
}

/** The deepest directory that contains every path (their common ancestor). */
export const commonDir = (paths: string[]): string => {
  if (paths.length === 0) return ""
  const dirs = paths.map((p) => dirname(p).split("/").filter(Boolean))
  let common = dirs[0] ?? []
  for (const d of dirs.slice(1)) {
    let i = 0
    while (i < common.length && i < d.length && common[i] === d[i]) i++
    common = common.slice(0, i)
  }
  return common.join("/")
}

/** One file in a bundle: its repo path and its path relative to the bundle root. */
export interface BundleMember {
  repoPath: string
  rel: string
}

/** A plan to mirror one HTML file as a bundle. `members` includes the entry. */
export interface BundlePlan {
  entryPath: string
  /** Bundle root within the repo (common ancestor of all members). */
  root: string
  /** Entry path relative to the bundle root. */
  entryRel: string
  members: BundleMember[]
}

/**
 * Plan a bundle for one HTML entry: gather its local asset references plus the
 * assets its stylesheets pull (transitively through @import — fonts, background
 * images), keep the ones that exist in the repo, and root everything at their
 * common ancestor. Returns null when the page references no local assets — the
 * caller then mirrors it as a plain single file, exactly as before.
 *
 * @param hasPath  does a repo path exist in the tree
 * @param fetchText  read a repo file as text (used to follow stylesheet refs)
 */
export const planBundle = async (
  entryPath: string,
  entryHtml: string,
  hasPath: (p: string) => boolean,
  fetchText: (p: string) => Promise<string | null>,
): Promise<BundlePlan | null> => {
  const entryDir = dirname(entryPath)
  const assets = new Set<string>()

  for (const ref of htmlAssetRefs(entryHtml)) {
    if (!isLocalRef(ref)) continue
    const p = resolveRef(entryDir, ref)
    if (p && p !== entryPath && hasPath(p)) assets.add(p)
  }

  // Follow stylesheets transitively (a CSS may @import another CSS, which pulls
  // the fonts/images): BFS over the .css files we've gathered, scanning each once,
  // so an @import chain or a shared reset resolves its assets too. Bounded by the
  // finite repo tree + the `scanned` set, so it always terminates.
  const cssQueue = [...assets].filter((p) => /\.css$/i.test(p))
  const scanned = new Set<string>()
  while (cssQueue.length) {
    const cssPath = cssQueue.shift() as string
    if (scanned.has(cssPath)) continue
    scanned.add(cssPath)
    const css = await fetchText(cssPath)
    if (!css) continue
    const cssDir = dirname(cssPath)
    for (const ref of cssAssetRefs(css)) {
      if (!isLocalRef(ref)) continue
      const q = resolveRef(cssDir, ref)
      if (q && q !== entryPath && hasPath(q) && !assets.has(q)) {
        assets.add(q)
        if (/\.css$/i.test(q)) cssQueue.push(q)
      }
    }
  }

  if (assets.size === 0) return null

  const allPaths = [entryPath, ...assets]
  const root = commonDir(allPaths)
  const rel = (p: string) => (root ? p.slice(root.length + 1) : p)
  return {
    entryPath,
    root,
    entryRel: rel(entryPath),
    members: allPaths.map((repoPath) => ({ repoPath, rel: rel(repoPath) })),
  }
}
