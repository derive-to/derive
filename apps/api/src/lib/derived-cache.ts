import {
  type BlobStore,
  elideDataUris,
  isHtmlLike,
  type SectionMarker,
  sectionMarkers,
  sha256Hex,
  toMarkdown,
} from "@derive/core"
import { log } from "../log"

/**
 * Lazy, content-addressed cache for the two EXPENSIVE derived views of one exact
 * source: the markdown conversion and the search section markers.
 *
 * Only these two are cached, on purpose (benchmarked 2026-07-13 on real content):
 * at 4MB, toMarkdown is ~41ms and sectionMarkers ~83ms — the costs agents feel,
 * repeatedly, on the same big doc. The other derived views (visible text, heading
 * outline, landmark map) are ALL cheap (~6ms even at 4MB), so callers compute those
 * inline — caching them would only make a small view fetch the whole multi-MB blob.
 * Below ~150K chars nothing is cached: the whole ladder is 1-12ms/session there, so
 * the cache would only add I/O — small docs stay byte-for-byte on the direct path.
 * Above ~8M chars nothing is cached either: a miss would compute + serialize a
 * multi-MB payload (peak memory a few times the source), and workspace search runs
 * several concurrently — an upper bound keeps a handful of huge docs from exhausting
 * an edge isolate. Giant docs take the direct single-view path, exactly as before.
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
  markers: SectionMarker[]
}

export interface DerivedCacheDeps {
  meta: {
    getDerivedView(sourceSha: string): Promise<{ blob_key: string } | null>
    putDerivedView(rec: { source_sha: string; blob_key: string }): Promise<void>
  }
  blobs: BlobStore
  /** Run the miss-path PERSIST (blob put + row write) off the read response. On the
   *  Workers edge this is waitUntil, so a GET isn't held open for a D1 write; on Node
   *  it awaits inline. Omit ⇒ the persist awaits inline (unit tests, and any caller
   *  that doesn't hold a request context). Either way the read returns the same
   *  views — persistence is best-effort and never blocks correctness. */
  background?: (work: Promise<unknown>) => Promise<void>
}

/** Below this source size, computing views directly is already ~free (1-12ms per
 *  whole session, measured) — the cache would only add blob I/O. Matches the same
 *  order of magnitude as the conflict-diff guard in edits.ts, for the same reason:
 *  ~150K chars is where per-read costs start to matter. */
export const DERIVED_CACHE_MIN_CHARS = 150_000

/** ABOVE this source size the cache is skipped and the caller takes the direct
 *  single-view path (exactly the pre-cache behavior). A miss computes BOTH views
 *  and JSON-serializes them — a ~3-4x peak-memory multiple of the source — and
 *  workspace search runs up to 4 of these concurrently in one isolate. Uploads can
 *  reach MAX_UPLOAD_BYTES (100MB), so without a ceiling a handful of huge HTML docs
 *  could exhaust a 128MB edge isolate. 8M chars keeps 4 concurrent misses well under
 *  budget while still caching every realistically-large dashboard/deck. Giant docs
 *  are rare and read directly — a single view, no serialized copy, no blob. */
export const DERIVED_CACHE_MAX_CHARS = 8_000_000

const computeViews = (src: string, contentType: string): DerivedViews => ({
  // Byte-identical to what the direct paths produce: markdown elides data: URIs
  // exactly as present() does; markers are the source-scope sectionMarkers search
  // uses. Substitution transparency — a hit == a miss, byte for byte.
  markdown: elideDataUris(toMarkdown(src, contentType)),
  markers: sectionMarkers(src, contentType),
})

/**
 * The two expensive derived views for `src`, through the cache when the doc is big
 * enough to benefit. Small docs and non-HTML sources return null — the caller
 * computes the view it needs directly, exactly as before this cache existed (only
 * HTML earns the round trip).
 *
 * On a miss this computes BOTH cached views even if the caller wants one — a
 * deliberate trade: their combined cost is bounded (~124ms worst case on a 4MB doc,
 * one time per unique content), and every subsequent read/search on this content
 * becomes a single blob read instead.
 */
export const derivedViewsFor = async (
  deps: DerivedCacheDeps,
  src: string,
  contentType: string,
): Promise<DerivedViews | null> => {
  if (
    !isHtmlLike(contentType) ||
    src.length < DERIVED_CACHE_MIN_CHARS ||
    src.length > DERIVED_CACHE_MAX_CHARS
  ) {
    return null
  }

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
  // Persist off the read response (edge: waitUntil; Node: inline). A never-rejecting
  // promise so it's safe whether awaited inline or handed to waitUntil: a failed write
  // just means the next read of this content recomputes (best-effort), never an alarm
  // beyond a log. A racing concurrent miss recomputes + rewrites the SAME content-
  // addressed blob/row — idempotent, no corruption.
  const persist = (async () => {
    try {
      const blobKey = await deps.blobs.put(new TextEncoder().encode(JSON.stringify(views)))
      await deps.meta.putDerivedView({ source_sha: sha, blob_key: blobKey })
    } catch (err) {
      log.warn("derived-view cache write failed", {
        sourceSha: sha,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })()
  if (deps.background) await deps.background(persist)
  else await persist
  return views
}
