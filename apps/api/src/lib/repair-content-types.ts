import { type BlobStore, looksLikeHtmlDocument, type MetaStore } from "@dock/core"

export interface ContentTypeRepairReport {
  /** Single-file `text/markdown` versions inspected. */
  scanned: number
  /** Versions reclassified to `text/html` (their bytes were a full HTML document). */
  fixed: number
  /** What was fixed, for the response/log. */
  items: { short_id: string; version: number; title: string | null }[]
}

const PAGE = 200
const SNIFF_BYTES = 512

/**
 * Detect single-file versions stored as `text/markdown` whose bytes are actually a
 * full HTML document and reclassify them to `text/html` — so the viewer stops
 * rendering them blank (the markdown path strips `<head>`/`<style>`/scripts). This
 * is the cleanup for content that predates the publish-time sniff (e.g. HTML synced
 * from a repo under a `.md` name).
 *
 * Read-mostly: it only writes the rows it actually fixes, and only ever promotes
 * markdown→html on a genuine HTML document (never the reverse), so it's safe to run
 * repeatedly. Scoped to one workspace when `orgId` is given; `limit` caps the number
 * of fixes per call.
 */
export async function repairHtmlMistypedAsMarkdown(
  meta: MetaStore,
  blobs: BlobStore,
  opts: { orgId?: string; limit?: number } = {},
): Promise<ContentTypeRepairReport> {
  const report: ContentTypeRepairReport = { scanned: 0, fixed: 0, items: [] }
  const dec = new TextDecoder()
  let cursor: { created_at: string; id: string } | undefined

  for (;;) {
    const page = await meta.listArtifacts({ orgId: opts.orgId, limit: PAGE, cursor })
    if (page.length === 0) break
    for (const a of page) {
      for (const v of await meta.listVersions(a.id)) {
        if (v.content_type !== "text/markdown") continue
        report.scanned++
        const bytes = await blobs.get(v.blob_key)
        if (!bytes) continue
        if (looksLikeHtmlDocument(dec.decode(bytes.slice(0, SNIFF_BYTES)))) {
          await meta.reclassifyVersion(a.id, v.n, "text/html")
          report.fixed++
          report.items.push({ short_id: a.short_id, version: v.n, title: a.title })
          if (opts.limit && report.fixed >= opts.limit) return report
        }
      }
    }
    const last = page[page.length - 1]
    if (!last || page.length < PAGE) break
    cursor = { created_at: last.created_at, id: last.id }
  }
  return report
}
