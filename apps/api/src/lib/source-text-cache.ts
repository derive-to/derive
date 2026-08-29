type SourceText = { text: string; bytes: number }

type CacheEntry = SourceText & { expiresAt: number }

export type SourceTextCacheOptions = {
  maxBytes?: number
  maxEntries?: number
  maxEntryBytes?: number
  idleTtlMs?: number
  now?: () => number
}

const MEBIBYTE = 1024 * 1024

/**
 * A small, per-process cache for immutable artifact source blobs.
 *
 * Blob keys are content addressed, so a new artifact version gets a new key. The
 * cache uses a weighted LRU and a sliding idle timeout to keep hot artifacts while
 * bounding memory. It also shares one load between concurrent readers.
 */
export class SourceTextCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<SourceText | null>>()
  private readonly maxBytes: number
  private readonly maxEntries: number
  private readonly maxEntryBytes: number
  private readonly idleTtlMs: number
  private readonly now: () => number
  private totalBytes = 0

  constructor(options: SourceTextCacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? 32 * MEBIBYTE
    this.maxEntries = options.maxEntries ?? 64
    this.maxEntryBytes = options.maxEntryBytes ?? 26 * MEBIBYTE
    this.idleTtlMs = options.idleTtlMs ?? 2 * 60 * 1000
    this.now = options.now ?? Date.now
  }

  async get(key: string, load: () => Promise<SourceText | null>): Promise<string | null> {
    const now = this.now()
    this.removeExpired(now)

    const cached = this.entries.get(key)
    if (cached) {
      cached.expiresAt = now + this.idleTtlMs
      this.entries.delete(key)
      this.entries.set(key, cached)
      return cached.text
    }

    const pending = this.inflight.get(key)
    if (pending) return (await pending)?.text ?? null

    const request = load()
    this.inflight.set(key, request)
    try {
      const source = await request
      if (!source || source.bytes > this.maxEntryBytes || this.maxEntries === 0) {
        return source?.text ?? null
      }

      const entry = { ...source, expiresAt: this.now() + this.idleTtlMs }
      this.entries.set(key, entry)
      this.totalBytes += entry.bytes
      this.evictToLimits()
      return source.text
    } finally {
      this.inflight.delete(key)
    }
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
