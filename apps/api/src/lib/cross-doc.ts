import type { ArtifactRecord, MetaStore } from "@dock/core"
import { collectSiblingPaths, rewriteCrossDocLinks } from "@dock/core"

/**
 * The serve-time HTML transform that turns a GitHub-synced artifact's relative
 * cross-document links (`<a href="walkthrough.html">`, or a markdown `[x](./x.md)`
 * rendered to one) into in-app navigations to the sibling artifact each resolves to.
 *
 * Resolution keys on `source_path`: a relative href resolves against this artifact's
 * repo path, and a sibling is any artifact in the same workspace published at that
 * exact path. Returns undefined when the artifact isn't synced (no `source_path`) —
 * there's nothing to resolve against, so serving stays untouched.
 *
 * One bounded query per served page (the distinct sibling paths actually linked, not
 * the whole repo); a page with no resolvable links makes no query at all.
 */
export const crossDocTransform = (
  meta: Pick<MetaStore, "siblingsBySourcePaths">,
  artifact: Pick<ArtifactRecord, "org_id" | "source_path">,
): ((html: string) => Promise<string>) | undefined => {
  const sourcePath = artifact.source_path
  if (!sourcePath) return undefined
  return async (html) => {
    const paths = collectSiblingPaths(html, sourcePath).filter((p) => p !== sourcePath)
    if (paths.length === 0) return html
    const siblings = await meta.siblingsBySourcePaths(artifact.org_id, paths)
    if (siblings.length === 0) return html
    const refByPath = new Map<string, string>()
    // Skip a self-link (a doc referencing its own path) — re-navigating to the page
    // you're on is pointless and would just reload the frame.
    for (const s of siblings)
      if (s.source_path !== sourcePath)
        refByPath.set(s.source_path, s.slug ? `${s.slug}-${s.short_id}` : s.short_id)
    return rewriteCrossDocLinks(html, sourcePath, refByPath)
  }
}
