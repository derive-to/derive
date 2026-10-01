import { type BlobStore, type BundleManifest, isBundleContentType } from "@derive/core"
import { edgeWaitUntil } from "../realtime-do"

export type WeightedLruCacheOptions = {
  maxBytes?: number
  maxEntries?: number
  maxEntryBytes?: number
  idleTtlMs?: number
  now?: () => number
}

const MEBIBYTE = 1024 * 1024

type WeightedEntry<T> = { value: T; bytes: number; expiresAt: number }

/** A byte-bounded LRU with a sliding idle timeout. */
export class WeightedLruCache<T> {
  private readonly entries = new Map<string, WeightedEntry<T>>()
  private readonly maxBytes: number
  private readonly maxEntries: number
  private readonly maxEntryBytes: number
  private readonly idleTtlMs: number
  private readonly now: () => number
  private totalBytes = 0

  constructor(options: WeightedLruCacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? 32 * MEBIBYTE
    this.maxEntries = options.maxEntries ?? 64
    this.maxEntryBytes = options.maxEntryBytes ?? this.maxBytes
    this.idleTtlMs = options.idleTtlMs ?? 2 * 60 * 1000
    this.now = options.now ?? Date.now
  }

  get(key: string): T | undefined {
    const now = this.now()
    this.removeExpired(now)
    const cached = this.entries.get(key)
    if (!cached) return undefined
    cached.expiresAt = now + this.idleTtlMs
    this.entries.delete(key)
    this.entries.set(key, cached)
    return cached.value
  }

  set(key: string, value: T, bytes: number): void {
    if (bytes > this.maxEntryBytes || this.maxEntries === 0) return
    const previous = this.entries.get(key)
    if (previous) this.totalBytes -= previous.bytes
    this.entries.delete(key)
    this.entries.set(key, { value, bytes, expiresAt: this.now() + this.idleTtlMs })
    this.totalBytes += bytes
    this.evictToLimits()
  }

  private removeExpired(now: number) {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > now) continue
      this.entries.delete(key)
      this.totalBytes -= entry.bytes
    }
  }

  private evictToLimits() {
    while (this.totalBytes > this.maxBytes || this.entries.size > this.maxEntries) {
      const oldest = this.entries.entries().next().value
      if (!oldest) return
      const [key, entry] = oldest
      this.entries.delete(key)
      this.totalBytes -= entry.bytes
    }
  }
}

type SourceText = { text: string; bytes: number }

/**
 * A small, per-process cache for immutable artifact source blobs.
 *
 * Blob keys are content addressed, so a new artifact version gets a new key. The
 * cache uses a weighted LRU and a sliding idle timeout to keep hot artifacts while
 * bounding memory. It also shares one load between concurrent readers.
 */
export class SourceTextCache {
  private readonly cache: WeightedLruCache<string>
  private readonly inflight = new Map<string, Promise<SourceText | null>>()
  private readonly maxEntryBytes: number

  constructor(options: WeightedLruCacheOptions = {}) {
    this.maxEntryBytes = options.maxEntryBytes ?? 26 * MEBIBYTE
    this.cache = new WeightedLruCache({ ...options, maxEntryBytes: this.maxEntryBytes })
  }

  /** A source this process just wrote (its blob key names these very bytes). */
  put(key: string, text: string): void {
    this.cache.set(key, text, text.length * 2)
  }

  async get(key: string, load: () => Promise<SourceText | null>): Promise<string | null> {
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached

    const pending = this.inflight.get(key)
    if (pending) return (await pending)?.text ?? null

    const request = load()
    this.inflight.set(key, request)
    try {
      const source = await request
      if (!source) return null
      this.cache.set(key, source.text, source.bytes)
      return source.text
    } finally {
      this.inflight.delete(key)
    }
  }
}

/** The Workers edge cache (the colo's, shared by every isolate there), or null on Node. */
const edgeCache = (): Cache | null =>
  (globalThis as { caches?: { default?: Cache } }).caches?.default ?? null
/** Keyed by the blob key, which is the bytes' own hash, on a host nothing outside this
 *  worker can ask for. */
const edgeUrl = (blobKey: string) => `https://sources.derive.internal/${blobKey}`
const keepAtEdge = (blobKey: string, text: string) => {
  const edge = edgeCache()
  if (edge)
    edgeWaitUntil(
      edge
        .put(
          edgeUrl(blobKey),
          new Response(text, { headers: { "cache-control": "public, max-age=604800" } }),
        )
        .catch(() => {}),
    )
}

/**
 * Stored sources as text: from this process's cache, else (a single file, on Workers) the
 * colo's edge cache, else object storage. A save that lands on a cold isolate reads the
 * version it edits from the edge cache, and `remember` keeps what a publish just stored, so
 * the session's next save reads nothing back. A bundle reads its entry file.
 */
export const sourceTexts = (blobs: BlobStore, cache = new SourceTextCache()) => {
  const sourceText = (content: { blob_key: string; content_type: string }) =>
    cache.get(`${content.content_type}:${content.blob_key}`, async () => {
      if (isBundleContentType(content.content_type)) {
        const manifestBytes = await blobs.get(content.blob_key)
        if (!manifestBytes) return null
        const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as BundleManifest
        const entryFile = manifest.files[manifest.entry]
        const data = entryFile ? await blobs.get(entryFile.key) : null
        if (!data) return null
        const text = new TextDecoder().decode(data)
        return { text, bytes: Math.max(data.byteLength, text.length * 2) }
      }
      const kept = await edgeCache()
        ?.match(edgeUrl(content.blob_key))
        .catch(() => undefined)
      if (kept) {
        const text = await kept.text()
        return { text, bytes: text.length * 2 }
      }
      const data = await blobs.get(content.blob_key)
      if (!data) return null
      const text = new TextDecoder().decode(data)
      keepAtEdge(content.blob_key, text)
      return { text, bytes: Math.max(data.byteLength, text.length * 2) }
    })
  /** Keep a single file's source this process just stored. */
  const rememberSource = (content: { blob_key: string; content_type: string }, text: string) => {
    if (isBundleContentType(content.content_type)) return
    cache.put(`${content.content_type}:${content.blob_key}`, text)
    keepAtEdge(content.blob_key, text)
  }
  return { sourceText, rememberSource }
}
