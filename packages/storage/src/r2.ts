import { type BlobStore, type BlobWriter, bufferedWriter, sha256Hex } from "@derive/core"

/** Structural type for a Cloudflare R2 binding (no hard dep on workers-types). */
export interface R2Like {
  put(key: string, value: Uint8Array | ArrayBuffer): Promise<unknown>
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>
  /** R2's metadata-only read; optional so a minimal test double stays valid. */
  head?(key: string): Promise<unknown | null>
  /** Needed to stream a file in (see `writer`); optional for the same reason. */
  delete?(key: string): Promise<void>
}

/** The streaming half of the same binding. It stays out of R2Like because Node's and
 *  workerd's stream types do not line up structurally, so a binding typed by one would not
 *  pass for the other; the one place that streams looks at the binding this way instead. */
interface R2Streaming {
  put(key: string, value: ReadableStream<Uint8Array>): Promise<unknown>
  get(key: string): Promise<{ body: ReadableStream<Uint8Array> } | null>
}

/** What streaming a file into R2 needs from the runtime, which workerd has and Node does
 *  not: a hash fed as a stream (`crypto.DigestStream`), and a body whose length R2 is told
 *  up front (`FixedLengthStream`), because R2 refuses a streamed upload of unknown length. */
export interface R2Streams {
  digest(): WritableStream<Uint8Array> & { readonly digest: Promise<ArrayBuffer> }
  fixedLength(size: number): TransformStream<Uint8Array, Uint8Array>
}

/** The runtime's own streams, where it has them; null elsewhere. */
const runtimeStreams = (): R2Streams | null => {
  const g = globalThis as unknown as {
    FixedLengthStream?: new (size: number) => TransformStream<Uint8Array, Uint8Array>
    crypto?: {
      DigestStream?: new (
        algorithm: string,
      ) => WritableStream<Uint8Array> & { readonly digest: Promise<ArrayBuffer> }
    }
  }
  const Fixed = g.FixedLengthStream
  const Digest = g.crypto?.DigestStream
  if (!Fixed || !Digest) return null
  return { digest: () => new Digest("SHA-256"), fixedLength: (size) => new Fixed(size) }
}

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("")

/** Cloudflare R2 blob store. A generic S3-compatible driver covers S3/GCS/MinIO. */
export class R2BlobStore implements BlobStore {
  constructor(
    private bucket: R2Like,
    private streams: R2Streams | null = runtimeStreams(),
  ) {}

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

  async has(key: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(key)) return false
    // head is metadata-only on a real binding; a double without it can't answer
    // cheaply, and `has` must never turn into a body read — report "exists" so the
    // lint stays quiet rather than false-positive.
    if (!this.bucket.head) return true
    return (await this.bucket.head(key)) !== null
  }

  /**
   * Stream a file into R2 without holding it. Its content key is only known once every byte
   * has been hashed, and R2 cannot rename, so the bytes go to a temporary object and are
   * copied under their key, unless that key already holds them. A temporary name can never
   * pass for a content key, so no reader sees one. Where the runtime cannot stream, the file
   * is collected and put instead.
   */
  writer(size: number): BlobWriter {
    const streams = this.streams
    const bucket = this.bucket
    const remove = bucket.delete?.bind(bucket)
    if (!streams || !remove) return bufferedWriter(size, (data) => this.put(data))
    const streaming = bucket as unknown as R2Streaming
    const temp = `tmp/${crypto.randomUUID()}`
    const hash = streams.digest()
    const hashing = hash.getWriter()
    const body = streams.fixedLength(size)
    const sending = body.writable.getWriter()
    const upload = streaming.put(temp, body.readable)
    // A failed upload is reported by close(), and an abandoned stream rejects its digest;
    // until someone asks for either, neither rejection may go unheard.
    upload.catch(() => undefined)
    hash.digest.catch(() => undefined)
    let written = 0
    const discard = async (): Promise<void> => {
      await Promise.allSettled([hashing.abort(), sending.abort()])
      await upload.catch(() => undefined)
      await remove(temp).catch(() => undefined)
    }
    return {
      write: async (bytes) => {
        written += bytes.byteLength
        // A copy for each stream: a runtime may take ownership of a buffer it is handed,
        // and these bytes can be a view of a buffer other files still need.
        await hashing.write(bytes.slice())
        await sending.write(bytes.slice())
      },
      close: async () => {
        if (written !== size) {
          await discard()
          throw new Error(`blob stream ended at ${written} of ${size} bytes`)
        }
        try {
          await Promise.all([hashing.close(), sending.close()])
          await upload
          const key = hex(await hash.digest)
          const stored = bucket.head ? (await bucket.head(key)) !== null : false
          if (!stored) {
            const staged = await streaming.get(temp)
            if (!staged?.body) throw new Error("the streamed blob could not be read back")
            const copy = streams.fixedLength(size)
            const copying = streaming.put(key, copy.readable)
            await staged.body.pipeTo(copy.writable)
            await copying
          }
          return key
        } finally {
          await remove(temp).catch(() => undefined)
        }
      },
      abort: discard,
    }
  }
}
