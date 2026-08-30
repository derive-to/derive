import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { FsBlobStore } from "../src/fs"
import { R2BlobStore, type R2Like } from "../src/r2"
import { s3FromUrl } from "../src/s3"

const bytes = (s: string) => new TextEncoder().encode(s)
const str = (u: Uint8Array | null) => (u ? new TextDecoder().decode(u) : null)
const SHA_RE = /^[0-9a-f]{64}$/

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

  it("uses bounded native multipart for large writes", async () => {
    const puts = vi.fn()
    const uploaded: { partNumber: number; value: Uint8Array }[] = []
    let completed: { partNumber: number; etag: string }[] = []
    const multipart = new R2BlobStore(
      {
        put: puts,
        get: async () => null,
        createMultipartUpload: async () => ({
          uploadPart: async (partNumber, value) => {
            uploaded.push({ partNumber, value })
            return { partNumber, etag: `part-${partNumber}` }
          },
          complete: async (parts) => {
            completed = parts
          },
          abort: async () => {},
        }),
      },
      { multipart: true },
    )
    const data = new Uint8Array(11 * 1024 * 1024 + 17)
    data[data.length - 1] = 7

    const key = await multipart.put(data)

    expect(key).toMatch(SHA_RE)
    expect(puts).not.toHaveBeenCalled()
    expect(
      uploaded.map((part) => [part.partNumber, part.value.byteLength]).sort((a, b) => a[0] - b[0]),
    ).toEqual([
      [1, 5 * 1024 * 1024],
      [2, 5 * 1024 * 1024],
      [3, 1024 * 1024 + 17],
    ])
    expect(completed.map((part) => part.partNumber)).toEqual([1, 2, 3])
  })

  it("keeps writes below the multipart threshold on the single-put path", async () => {
    const put = vi.fn(async () => {})
    const createMultipartUpload = vi.fn()
    const store = new R2BlobStore(
      { put, get: async () => null, createMultipartUpload },
      { multipart: true },
    )

    await store.put(new Uint8Array(8 * 1024 * 1024 - 1))

    expect(put).toHaveBeenCalledOnce()
    expect(createMultipartUpload).not.toHaveBeenCalled()
  })

  it("retries transient part failures before it completes", async () => {
    const attempts = new Map<number, number>()
    const complete = vi.fn(async () => {})
    const abort = vi.fn(async () => {})
    const store = new R2BlobStore(
      {
        put: async () => {},
        get: async () => null,
        createMultipartUpload: async () => ({
          uploadPart: async (partNumber) => {
            const attempt = (attempts.get(partNumber) ?? 0) + 1
            attempts.set(partNumber, attempt)
            if (partNumber === 2 && attempt < 3) throw new Error("temporary failure")
            return { partNumber, etag: `part-${partNumber}` }
          },
          complete,
          abort,
        }),
      },
      { multipart: true },
    )

    await store.put(new Uint8Array(9 * 1024 * 1024))

    expect(attempts.get(2)).toBe(3)
    expect(complete).toHaveBeenCalledOnce()
    expect(abort).not.toHaveBeenCalled()
  })

  it("accepts a committed object when the complete response is lost", async () => {
    const abort = vi.fn(async () => {})
    const store = new R2BlobStore(
      {
        put: async () => {},
        get: async () => null,
        head: async () => ({}),
        createMultipartUpload: async () => ({
          uploadPart: async (partNumber) => ({ partNumber, etag: `part-${partNumber}` }),
          complete: async () => {
            throw new Error("response lost")
          },
          abort,
        }),
      },
      { multipart: true },
    )

    await expect(store.put(new Uint8Array(9 * 1024 * 1024))).resolves.toMatch(SHA_RE)
    expect(abort).toHaveBeenCalledOnce()
  })

  it("aborts a failed multipart write and leaves the error intact", async () => {
    const abort = vi.fn(async () => {})
    const complete = vi.fn(async () => {})
    let failedPartAttempts = 0
    const multipart = new R2BlobStore(
      {
        put: async () => {},
        get: async () => null,
        createMultipartUpload: async () => ({
          uploadPart: async (partNumber) => {
            if (partNumber === 2) {
              failedPartAttempts++
              throw new Error("part failed")
            }
            return { partNumber, etag: `part-${partNumber}` }
          },
          complete,
          abort,
        }),
      },
      { multipart: true },
    )

    await expect(multipart.put(new Uint8Array(9 * 1024 * 1024))).rejects.toThrow("part failed")
    expect(failedPartAttempts).toBe(3)
    expect(complete).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledOnce()
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
