import {
  type BlobStore,
  elideDataUris,
  isHtmlLike,
  type LandmarkRegion,
  landmarksOf,
  type OutlineSection,
  outlineOf,
  pageText,
  type SectionMarker,
  sectionMarkers,
  sha256Hex,
  toMarkdown,
} from "@derive/core"
import { log } from "../log"

/**
 * Lazy, content-addressed cache for the derived views of one exact source: the
 * markdown conversion, visible text, heading outline, landmark map, and search
 * section markers — everything the read/search ladder recomputes per call today.
 *
 * Design (benchmarked 2026-07-13 on real content): below ~150K chars the whole
 * ladder costs 1-12ms per agent session, so caching would only add I/O — the gate
 * keeps small docs on the direct path, byte-for-byte unchanged. Above it, the
 * per-call cost climbs to 42-215ms/session (sectionMarkers alone is ~83ms per
 * search on a 4MB doc) while a cache hit is 0.3-5ms — an 8-40x win exactly where
 * agents feel it, because they search/read the same big doc repeatedly in a
 * session.
 *
 * Content addressing IS the invalidation: the key is the sha of the source, so a
 * new version is a new key and rows can never go stale. No TTL, no write-path
 * hook, no eviction logic (rows for content nothing references are inert; the
 * blob store is content-addressed too, so identical republish reuses everything).
 * Every cache interaction is best-effort — a store hiccup falls back to computing
 * exactly what today's path computes, and only the WRITE failure is logged (a
 * read fallback needs no alarm; losing writes silently would).
 */
export interface DerivedViews {
  markdown: string
  text: string
  outline: OutlineSection[]
  landmarks: LandmarkRegion[]
  markers: SectionMarker[]
}

export interface DerivedCacheDeps {
  meta: {
    getDerivedView(sourceSha: string): Promise<{ blob_key: string } | null>
    putDerivedView(rec: { source_sha: string; blob_key: string }): Promise<void>
  }
  blobs: BlobStore
}

/** Below this source size, computing views directly is already ~free (1-12ms per
 *  whole session, measured) — the cache would only add blob I/O. Matches the same
 *  order of magnitude as the conflict-diff guard in edits.ts, for the same reason:
 *  ~150K chars is where per-read costs start to matter. */
export const DERIVED_CACHE_MIN_CHARS = 150_000

const computeViews = (src: string, contentType: string): DerivedViews => ({
  // Matches lib/search.ts's present() for each format EXACTLY (markdown elides
  // data: URIs there, text is pageText for HTML) — the cache must be substitution-
  // transparent: same bytes out whether a call hit the cache or computed directly.
  markdown: elideDataUris(toMarkdown(src, contentType)),
  text: pageText(src),
  outline: outlineOf(src, contentType),
  landmarks: landmarksOf(src, contentType),
  markers: sectionMarkers(src, contentType),
})

/**
 * The derived views for `src`, through the cache when the doc is big enough to
 * benefit. Small docs and non-HTML sources return null — the caller computes the
 * one view it needs directly, exactly as before this cache existed (markdown and
 * plain text are near-passthrough conversions, so only HTML earns the round trip).
 *
 * On a miss this computes ALL views even if the caller wants one — a deliberate
 * trade: the marginal cost of the other four is bounded (~240ms total worst case
 * on a 4MB doc, one time per unique content), and every subsequent call for ANY
 * view on this content becomes a single blob read.
 */
export const derivedViewsFor = async (
  deps: DerivedCacheDeps,
  src: string,
  contentType: string,
): Promise<DerivedViews | null> => {
  if (!isHtmlLike(contentType) || src.length < DERIVED_CACHE_MIN_CHARS) return null

  const sha = await sha256Hex(new TextEncoder().encode(src))
  try {
    const rec = await deps.meta.getDerivedView(sha)
    if (rec) {
      const bytes = await deps.blobs.get(rec.blob_key)
      if (bytes) return JSON.parse(new TextDecoder().decode(bytes)) as DerivedViews
    }
  } catch {
    // A failed cache READ is a plain fallback to compute — no alarm needed.
  }

  const views = computeViews(src, contentType)
  try {
    const blobKey = await deps.blobs.put(new TextEncoder().encode(JSON.stringify(views)))
    await deps.meta.putDerivedView({ source_sha: sha, blob_key: blobKey })
  } catch (err) {
    // A failed WRITE means every future read of this content pays full compute
    // again — worth knowing about, never worth failing the read that found it.
    log.warn("derived-view cache write failed", {
      sourceSha: sha,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return views
}
