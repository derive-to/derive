import { type BlobByteRange, type BlobStore, sha256Hex } from "@derive/core"
import { assertBlobByteRange } from "./blob-range"

/** Structural type for a Cloudflare R2 binding (no hard dep on workers-types). */
export interface R2Like {
  put(key: string, value: Uint8Array | ArrayBuffer): Promise<unknown>
  get(
    key: string,
    options?: { range: { offset: number; length: number } },
  ): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>
  /** R2's metadata-only read; optional so a minimal test double stays valid. */
  head?(key: string): Promise<unknown | null>
}

/** Cloudflare R2 blob store. A generic S3-compatible driver covers S3/GCS/MinIO. */
export class R2BlobStore implements BlobStore {
  constructor(private bucket: R2Like) {}

  async put(data: Uint8Array): Promise<string> {
    const key = await sha256Hex(data)
    await this.bucket.put(key, data)
    return key
  }

  async get(key: string): Promise<Uint8Array | null> {
    if (!/^[0-9a-f]{64}$/.test(key)) return null
    const obj = await this.bucket.get(key)
    if (!obj) return null
    return new Uint8Array(await obj.arrayBuffer())
  }

  async getRange(key: string, range: BlobByteRange): Promise<Uint8Array | null> {
    assertBlobByteRange(range)
    if (!/^[0-9a-f]{64}$/.test(key)) return null
    if (range.length === 0) return new Uint8Array()
    const obj = await this.bucket.get(key, { range })
    if (!obj) return null
    const body = new Uint8Array(await obj.arrayBuffer())
    if (body.length > range.length) throw new Error("r2 range response exceeded requested length")
    return body
  }

  async has(key: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(key)) return false
    // head is metadata-only on a real binding; a double without it can't answer
    // cheaply, and `has` must never turn into a body read — report "exists" so the
    // lint stays quiet rather than false-positive.
    if (!this.bucket.head) return true
    return (await this.bucket.head(key)) !== null
  }
}
