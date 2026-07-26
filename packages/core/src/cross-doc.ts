/**
 * Cross-document links between sibling artifacts.
 *
 * A folder mirrored from GitHub becomes many SEPARATE artifacts (each `.html` /
 * `.md` is its own short_id), but the source files reference each other with plain
 * relative links — `<a href="walkthrough.html">`, or a markdown `[x](./walkthrough.md)`
 * rendered to the same. Inside the sandboxed viewer iframe (src `/raw/<id>/v/<n>/…`)
 * such a link resolves to a path UNDER the current artifact, which the raw server
 * serves as the same single blob — so clicking a tab just re-renders the page you're
 * already on.
 *
 * The fix resolves each relative link against the source file's repo path and, when
 * it lands on a sibling artifact (same workspace, that exact `source_path`), rewrites
 * it to that sibling's in-app URL plus a `data-derive-nav` marker. The iframe client
 * intercepts marked links and the host does an SPA transition (see `anchor.ts` /
 * `use-artifact-frame.ts`). Links with no sibling are left untouched.
 *
 * Pure + dialect-free so it's unit-tested without a DB; the caller supplies the
 * `source_path → ref` map it resolved from the artifact table.
 */

/**
 * Resolve a link's `href`, as written in `sourcePath`'s file, to the repo path it
 * points at — or null when it isn't an in-repo relative document link (an in-page
 * `#anchor`, an absolute/scheme/protocol-relative URL). Relative segments (`./`,
 * `../`) are normalized; a query/hash is dropped (the lookup keys on the file path).
 */
export const resolveSiblingPath = (sourcePath: string, href: string): string | null => {
  const h = href.trim()
  if (!h || h.startsWith("#")) return null
  if (h.startsWith("//")) return null // protocol-relative → another origin
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return null // http:, mailto:, tel:, data:, …
  try {
    // A throwaway origin lets the URL parser do the `./` + `../` normalization for us,
    // resolving against the source file's directory exactly as a browser would.
    const base = new URL(`https://derive.local/${sourcePath}`)
    const resolved = new URL(h, base)
    if (resolved.origin !== base.origin) return null
    const path = decodeURIComponent(resolved.pathname).replace(/^\/+/, "")
    return path || null
  } catch {
    return null
  }
}

/** Match an `<a>` opening tag and capture (attrs-before, quote, href, attrs-after). */
const A_TAG = /<a\b([^>]*?)\shref=(["'])([^"']*)\2([^>]*?)>/gi

/**
 * Every distinct sibling repo path a document's `<a href>`s point at — what the
 * caller looks up in the artifact table to build the `source_path → ref` map for
 * {@link rewriteCrossDocLinks}. Deduped; order is first-seen.
 */
export const collectSiblingPaths = (html: string, sourcePath: string): string[] => {
  const seen = new Set<string>()
  for (const m of html.matchAll(A_TAG)) {
    const path = resolveSiblingPath(sourcePath, m[3] ?? "")
    if (path) seen.add(path)
  }
  return [...seen]
}

/**
 * Rewrite each relative `<a href>` that resolves to a known sibling: point it at the
 * sibling's `/artifacts/<ref>` URL and tag it `data-derive-nav="<ref>"` so the iframe client
 * intercepts the click for an in-app transition. `refByPath` maps a resolved repo
 * path → its artifact ref (`<slug>-<short_id>`); paths absent from it are left as-is.
 * Already-tagged anchors are skipped so the pass is idempotent.
 */
export const rewriteCrossDocLinks = (
  html: string,
  sourcePath: string,
  refByPath: ReadonlyMap<string, string>,
): string => {
  if (refByPath.size === 0) return html
  return html.replace(A_TAG, (tag, pre: string, q: string, href: string, post: string) => {
    if (/\sdata-derive-nav=/i.test(pre) || /\sdata-derive-nav=/i.test(post)) return tag
    const path = resolveSiblingPath(sourcePath, href)
    const ref = path && refByPath.get(path)
    if (!ref) return tag
    return `<a${pre} href=${q}/artifacts/${ref}${q} data-derive-nav=${q}${ref}${q}${post}>`
  })
}
