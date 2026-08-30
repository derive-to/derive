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

  delete(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.totalBytes -= entry.bytes
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
