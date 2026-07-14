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
 * Above ~5MB (bytes) nothing is cached either: a miss would compute + serialize a
 * multi-MB payload (peak memory a few times the source), and workspace search runs
 * several concurrently — an upper bound keeps a handful of huge docs from exhausting
 * an edge isolate. Giant docs take the direct single-view path, exactly as before.
 *
 * Content addressing IS the invalidation: the key is a generation tag + the sha of
 * the source, so a new version is a new key and rows can never go stale. Content
 * addressing only covers CONTENT change, though — a change to the view code itself
 * (toMarkdown, sectionMarkers, elideDataUris, or the cached shape) must bump
 * DERIVED_CACHE_GEN, or old rows would silently serve the old algorithm's output
 * forever. No TTL, no write-path hook, no eviction logic (rows for content nothing
 * references are inert; the blob store is content-addressed too, so identical
 * republish reuses everything).
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

/** ABOVE this source size (in UTF-8 BYTES — the unit the isolate's memory budget is
 *  actually spent in; a chars gate undercounts CJK 3x) the cache is skipped and the
 *  caller takes the direct single-view path, exactly the pre-cache behavior. A miss
 *  holds the source, both views, the JSON string, and its encoded bytes at once —
 *  roughly a 3-4x multiple of the source — and workspace search runs up to 4 misses
 *  concurrently in one isolate, so at 5MB the cache's worst-case concurrent delta is
 *  ~60-80MB against a 128MB budget. Uploads can reach MAX_UPLOAD_BYTES (100MB);
 *  without this ceiling a handful of huge HTML docs could exhaust the isolate. Docs
 *  over the ceiling are rare and read directly — one view, no copies, no blob. */
export const DERIVED_CACHE_MAX_BYTES = 5_000_000

/** Cache GENERATION, part of every row key. Content addressing invalidates on
 *  content change; this invalidates on CODE change. Bump it whenever computeViews'
 *  output could differ for the same source — a semantic change to toMarkdown,
 *  sectionMarkers, or elideDataUris, or a change to the DerivedViews shape —
 *  otherwise existing rows keep serving the previous algorithm's output (there is
 *  no TTL to age them out). Old-generation rows are simply never read again. */
export const DERIVED_CACHE_GEN = "dv1"

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
  if (!isHtmlLike(contentType) || src.length < DERIVED_CACHE_MIN_CHARS) return null
  // The upper gate measures BYTES (chars undercount multi-byte text), on the encode
  // the sha needs anyway — over the ceiling costs one encode, no hash, no I/O.
  const encoded = new TextEncoder().encode(src)
  if (encoded.byteLength > DERIVED_CACHE_MAX_BYTES) return null

  const key = `${DERIVED_CACHE_GEN}:${await sha256Hex(encoded)}`
  try {
    const rec = await deps.meta.getDerivedView(key)
    if (rec) {
      const bytes = await deps.blobs.get(rec.blob_key)
      if (bytes) {
        // Validate the shape, don't just cast: the generation key already fences
        // off other generations, so this only catches a corrupt-but-valid-JSON
        // blob — which must read as a MISS (recompute + overwrite), never flow a
        // number into a .split() or a non-array into annotateSections.
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<DerivedViews>
        if (typeof parsed?.markdown === "string" && Array.isArray(parsed.markers))
          return parsed as DerivedViews
      }
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
      await deps.meta.putDerivedView({ source_sha: key, blob_key: blobKey })
    } catch (err) {
      log.warn("derived-view cache write failed", {
        sourceSha: key,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })()
  if (deps.background) await deps.background(persist)
  else await persist
  return views
}
