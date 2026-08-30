import { type BlobStore, sha256Hex } from "@derive/core"

/** Structural type for a Cloudflare R2 binding (no hard dep on workers-types). */
export interface R2Like {
  put(key: string, value: Uint8Array | ArrayBuffer): Promise<unknown>
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>
  /** R2's metadata-only read; optional so a minimal test double stays valid. */
  head?(key: string): Promise<unknown | null>
  /** Native multipart upload. Optional so custom bindings keep the single-put path. */
  createMultipartUpload?(key: string): Promise<R2MultipartUploadLike>
}

export interface R2UploadedPartLike {
  partNumber: number
  etag: string
}

export interface R2MultipartUploadLike {
  uploadPart(partNumber: number, value: Uint8Array): Promise<R2UploadedPartLike>
  complete(parts: R2UploadedPartLike[]): Promise<unknown>
  abort(): Promise<void>
}

export interface R2BlobStoreOptions {
  /** Parallelize complete large-object writes through R2's native multipart API. */
  multipart?: boolean
}

const MULTIPART_AT_BYTES = 8 * 1024 * 1024
const MULTIPART_PART_BYTES = 5 * 1024 * 1024
const MULTIPART_CONCURRENCY = 4
const MULTIPART_ATTEMPTS = 3
const MULTIPART_RETRY_MS = 25

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Cloudflare R2 blob store. A generic S3-compatible driver covers S3/GCS/MinIO. */
export class R2BlobStore implements BlobStore {
  constructor(
    private bucket: R2Like,
    private options: R2BlobStoreOptions = {},
  ) {}

  async put(data: Uint8Array): Promise<string> {
    const key = await sha256Hex(data)
    if (
      this.options.multipart &&
      data.byteLength >= MULTIPART_AT_BYTES &&
      this.bucket.createMultipartUpload
    ) {
      await this.putMultipart(key, data)
      return key
    }
    await this.bucket.put(key, data)
    return key
  }

  private async putMultipart(key: string, data: Uint8Array): Promise<void> {
    const upload = await this.bucket.createMultipartUpload?.(key)
    if (!upload) {
      await this.bucket.put(key, data)
      return
    }

    const count = Math.ceil(data.byteLength / MULTIPART_PART_BYTES)
    const parts = new Array<R2UploadedPartLike>(count)
    let next = 0
    let failure: unknown
    try {
      await Promise.all(
        Array.from({ length: Math.min(MULTIPART_CONCURRENCY, count) }, async () => {
          while (next < count && failure === undefined) {
            const index = next++
            const start = index * MULTIPART_PART_BYTES
            const end = Math.min(start + MULTIPART_PART_BYTES, data.byteLength)
            try {
              // subarray is a view, so splitting does not make another complete blob copy.
              parts[index] = await this.uploadPart(upload, index + 1, data.subarray(start, end))
            } catch (error) {
              failure ??= error
            }
          }
        }),
      )
      if (failure !== undefined) throw failure
      try {
        await upload.complete(parts)
      } catch (error) {
        // A complete request can commit and still lose its response. The key is the exact
        // content SHA, so an object at that key proves this write is already durable.
        const committed = this.bucket.head
          ? await this.bucket
              .head(key)
              .then((value) => value !== null)
              .catch(() => false)
          : false
        if (!committed) throw error
        // If the object already existed, this upload can still be incomplete. Abort is safe
        // after a completed upload and avoids leaving that second upload for lifecycle cleanup.
        await upload.abort().catch(() => {})
      }
    } catch (error) {
      await upload.abort().catch(() => {})
      throw error
    }
  }

  private async uploadPart(
    upload: R2MultipartUploadLike,
    partNumber: number,
    data: Uint8Array,
  ): Promise<R2UploadedPartLike> {
    let failure: unknown
    for (let attempt = 1; attempt <= MULTIPART_ATTEMPTS; attempt++) {
      try {
        return await upload.uploadPart(partNumber, data)
      } catch (error) {
        failure = error
        if (attempt < MULTIPART_ATTEMPTS) await wait(MULTIPART_RETRY_MS * 2 ** (attempt - 1))
      }
    }
    throw failure
  }

  async get(key: string): Promise<Uint8Array | null> {
    if (!/^[0-9a-f]{64}$/.test(key)) return null
    const obj = await this.bucket.get(key)
    if (!obj) return null
    return new Uint8Array(await obj.arrayBuffer())
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
