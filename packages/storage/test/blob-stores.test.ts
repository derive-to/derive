import { createHash } from "node:crypto"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha256Hex } from "@derive/core"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { FsBlobStore } from "../src/fs"
import { R2BlobStore, type R2Like, type R2Streams } from "../src/r2"
import { s3FromUrl } from "../src/s3"

const bytes = (s: string) => new TextEncoder().encode(s)
const str = (u: Uint8Array | null) => (u ? new TextDecoder().decode(u) : null)
const SHA_RE = /^[0-9a-f]{64}$/

/** Bytes nothing compresses, in a size past what getRandomValues fills at once. */
const noise = (size: number): Uint8Array => {
  const out = new Uint8Array(size)
  for (let at = 0; at < size; at += 65_536)
    crypto.getRandomValues(out.subarray(at, Math.min(at + 65_536, size)))
  return out
}

/** Write a file through a store's writer in pieces, the way an import streams one. */
const streamInto = async (
  writer: { write(b: Uint8Array): Promise<void>; close(): Promise<string> },
  data: Uint8Array,
): Promise<string> => {
  for (let at = 0; at < data.byteLength; at += 7_000)
    await writer.write(data.subarray(at, at + 7_000))
  return writer.close()
}

// Both content-addressed stores share the BlobStore contract: put returns a sha256
// hex key, get round-trips, a malformed key is rejected without a backend call, and
// a well-formed-but-absent key is null (not an error).
describe("FsBlobStore (local disk, the default store)", () => {
  const dir = mkdtempSync(join(tmpdir(), "derive-blobs-"))
  const store = new FsBlobStore(dir)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("puts content-addressed and round-trips it", async () => {
    const key = await store.put(bytes("hello world"))
    expect(key).toMatch(SHA_RE)
    expect(str(await store.get(key))).toBe("hello world")
  })

  it("accepts simultaneous identical writes in the same clock tick", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1)
    try {
      const keys = await Promise.all(
        Array.from({ length: 16 }, () => store.put(bytes("simultaneous bytes"))),
      )
      expect(new Set(keys).size).toBe(1)
      expect(str(await store.get(keys[0] ?? ""))).toBe("simultaneous bytes")
    } finally {
      clock.mockRestore()
    }
  })

  it("rejects a malformed key and returns null for a missing one", async () => {
    expect(await store.get("not-a-key")).toBeNull()
    expect(await store.get("a".repeat(64))).toBeNull() // valid shape, absent
  })

  it("has = a cheap stat: true for stored, false for absent or malformed", async () => {
    const key = await store.put(bytes("exists"))
    expect(await store.has(key)).toBe(true)
    expect(await store.has("c".repeat(64))).toBe(false)
    expect(await store.has("not-a-key")).toBe(false)
  })

  it("streams a file to its content key, leaving nothing half-written behind", async () => {
    const data = noise(300 * 1024)
    const key = await streamInto(store.writer(data.byteLength), data)
    expect(key).toBe(await sha256Hex(data))
    expect(await sha256Hex((await store.get(key)) ?? new Uint8Array())).toBe(key)
    // The same bytes again land on the same key.
    expect(await streamInto(store.writer(data.byteLength), data)).toBe(key)
    expect(readdirSync(dir).filter((name) => name.startsWith(".tmp-"))).toEqual([])
  })

  it("stores nothing when a stream ends short or is abandoned", async () => {
    const short = store.writer(10)
    await short.write(bytes("short"))
    await expect(short.close()).rejects.toThrow(/5 of 10/)
    const abandoned = store.writer(10)
    await abandoned.write(bytes("abandoned"))
    await abandoned.abort()
    expect(await store.has(await sha256Hex(bytes("short")))).toBe(false)
    expect(readdirSync(dir).filter((name) => name.startsWith(".tmp-"))).toEqual([])
  })
})

describe("R2BlobStore (Cloudflare R2)", () => {
  // A Map-backed stand-in for the R2 binding (structural R2Like, no workers-types).
  const map = new Map<string, Uint8Array>()
  const bucket: R2Like = {
    put: async (key, value) => {
      map.set(key, value instanceof Uint8Array ? value : new Uint8Array(value))
    },
    get: async (key) => {
      const v = map.get(key)
      return v ? { arrayBuffer: async () => v.slice().buffer } : null
    },
  }
  const store = new R2BlobStore(bucket)

  it("puts content-addressed and round-trips it", async () => {
    const key = await store.put(bytes("edge bytes"))
    expect(key).toMatch(SHA_RE)
    expect(map.has(key)).toBe(true)
    expect(str(await store.get(key))).toBe("edge bytes")
  })

  it("rejects a malformed key (no bucket call) and returns null for a missing one", async () => {
    expect(await store.get("nope")).toBeNull()
    expect(await store.get("b".repeat(64))).toBeNull()
  })

  it("has uses the binding's metadata-only head when present", async () => {
    const heads: string[] = []
    const withHead = new R2BlobStore({
      ...bucket,
      head: async (key: string) => {
        heads.push(key)
        return map.has(key) ? {} : null
      },
    })
    const key = await withHead.put(bytes("headed"))
    expect(await withHead.has(key)).toBe(true)
    expect(await withHead.has("d".repeat(64))).toBe(false)
    expect(await withHead.has("malformed")).toBe(false) // rejected before any call
    expect(heads).toEqual([key, "d".repeat(64)])
  })

  it("has answers 'exists' when the binding can't head — never a body read", async () => {
    // A double without head can't check cheaply; `has` reports true so the caller's
    // advisory stays quiet instead of false-positives (and never falls back to get).
    expect(await store.has("e".repeat(64))).toBe(true)
  })

  it("collects and puts a stream where the runtime cannot stream one", async () => {
    // Node has neither DigestStream nor FixedLengthStream: the file still lands on its key.
    const key = await streamInto(store.writer(8), bytes("abcdefgh"))
    expect(str(await store.get(key))).toBe("abcdefgh")
  })
})

describe("R2BlobStore streaming a file too large to hold", () => {
  /** workerd's DigestStream and FixedLengthStream, as Node can stand in for them. */
  const nodeStreams: R2Streams = {
    digest: () => {
      const hash = createHash("sha256")
      let resolve: (digest: ArrayBuffer) => void = () => {}
      const digest = new Promise<ArrayBuffer>((r) => {
        resolve = r
      })
      const sink = new WritableStream<Uint8Array>({
        write: (chunk) => {
          hash.update(chunk)
        },
        close: () => {
          resolve(new Uint8Array(hash.digest()).buffer)
        },
      })
      return Object.assign(sink, { digest })
    },
    fixedLength: () => new TransformStream<Uint8Array, Uint8Array>(),
  }

  /** A bucket that takes streamed bodies, as R2 does, and records each call with temporary
   *  names written as `tmp`. */
  const streamingBucket = () => {
    const objects = new Map<string, Uint8Array>()
    const calls: string[] = []
    const named = (key: string) => (key.startsWith("tmp/") ? "tmp" : key)
    const bucket: R2Like = {
      put: async (key, value) => {
        calls.push(`put ${named(key)}`)
        // A streamed upload arrives here as a ReadableStream, whatever R2Like says.
        const body = value as unknown as ConstructorParameters<typeof Response>[0]
        objects.set(key, new Uint8Array(await new Response(body).arrayBuffer()))
      },
      get: async (key) => {
        calls.push(`get ${named(key)}`)
        const v = objects.get(key)
        if (!v) return null
        const object = {
          arrayBuffer: async () => v.slice().buffer,
          body: new Response(v.slice()).body,
        }
        return object
      },
      head: async (key) => {
        calls.push(`head ${named(key)}`)
        return objects.has(key) ? {} : null
      },
      delete: async (key) => {
        calls.push(`delete ${named(key)}`)
        objects.delete(key)
      },
    }
    return { bucket, objects, calls }
  }

  it("goes through a temporary object to its content key, and skips the copy when stored", async () => {
    const { bucket, objects, calls } = streamingBucket()
    const store = new R2BlobStore(bucket, nodeStreams)
    const data = noise(300 * 1024)
    const key = await streamInto(store.writer(data.byteLength), data)
    expect(key).toBe(await sha256Hex(data))
    expect(await sha256Hex(objects.get(key) ?? new Uint8Array())).toBe(key)
    expect(calls).toEqual(["put tmp", `head ${key}`, "get tmp", `put ${key}`, "delete tmp"])
    expect([...objects.keys()]).toEqual([key])
    // The same bytes again are already under their key: nothing is copied.
    calls.length = 0
    expect(await streamInto(store.writer(data.byteLength), data)).toBe(key)
    expect(calls).toEqual(["put tmp", `head ${key}`, "delete tmp"])
    expect([...objects.keys()]).toEqual([key])
  })

  it("stores nothing under a content key when a stream ends short or is abandoned", async () => {
    const { bucket, objects } = streamingBucket()
    const store = new R2BlobStore(bucket, nodeStreams)
    const short = store.writer(10)
    await short.write(bytes("short"))
    await expect(short.close()).rejects.toThrow(/5 of 10/)
    const abandoned = store.writer(10)
    await abandoned.write(bytes("abandoned"))
    await abandoned.abort()
    expect([...objects.keys()]).toEqual([])
  })
})

describe("s3FromUrl", () => {
  it("rejects a URL with no bucket", () => {
    expect(() => s3FromUrl("s3://AK:SECRET@host.example.com/")).toThrow(/bucket/)
  })
})

// put/get sign a SigV4 request and hit the endpoint over fetch. A fetch stub backed
// by a Map stands in for the S3 server, so we exercise the signer + the success and
// error branches without a network.
describe("S3BlobStore put/get (SigV4 over fetch)", () => {
  const store = s3FromUrl("s3://minioadmin:minioadmin@localhost:9000/derive?region=us-east-1")
  afterEach(() => vi.unstubAllGlobals())

  // Records every request and serves PUT bodies back on GET (keyed by URL).
  const stubFetch = () => {
    const objects = new Map<string, Uint8Array>()
    const calls: { method: string; url: string; headers: Record<string, string> }[] = []
    const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? "GET"
      calls.push({ method, url, headers: init.headers as Record<string, string> })
      if (method === "PUT") {
        objects.set(url, new Uint8Array(init.body as ArrayBuffer))
        return new Response(null, { status: 200 })
      }
      const obj = objects.get(url)
      return obj ? new Response(obj, { status: 200 }) : new Response("nope", { status: 404 })
    })
    vi.stubGlobal("fetch", fetchStub)
    return { calls }
  }

  it("signs a PUT and returns the content-addressed key", async () => {
    const { calls } = stubFetch()
    const key = await store.put(new TextEncoder().encode("payload"))
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    const put = calls.find((c) => c.method === "PUT")
    expect(put?.url).toBe(`http://localhost:9000/derive/${key}`)
    // The SigV4 headers the signer must attach.
    expect(put?.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=minioadmin\//)
    expect(put?.headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/)
    expect(put?.headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/)
  })

  it("returns null for a missing object (404) and a malformed key (no fetch)", async () => {
    const { calls } = stubFetch()
    expect(await store.get("f".repeat(64))).toBeNull() // 404
    expect(await store.get("bad")).toBeNull() // rejected before any fetch
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1)
  })

  it("throws when put fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 403 })),
    )
    await expect(store.put(new TextEncoder().encode("x"))).rejects.toThrow(/s3 put .* failed: 403/)
  })
})

describe("S3BlobStore.has (metadata-only existence)", () => {
  const store = s3FromUrl("s3://AK:SECRET@s3.us-west-2.amazonaws.com/derive")

  it("HEADs rather than reading the body, and maps 404 to false", async () => {
    const calls: { method?: string }[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: { method?: string }) => {
        calls.push({ method: init?.method })
        return new Response(null, { status: 200 })
      }),
    )
    expect(await store.has("a".repeat(64))).toBe(true)
    expect(calls).toEqual([{ method: "HEAD" }])

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    )
    expect(await store.has("b".repeat(64))).toBe(false)
  })

  it("rejects a malformed key before any request", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    expect(await store.has("nope")).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("reports exists on a transport failure — an advisory must not cry wolf", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down")
      }),
    )
    expect(await store.has("c".repeat(64))).toBe(true)
  })
})
