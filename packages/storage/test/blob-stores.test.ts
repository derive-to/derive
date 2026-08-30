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

  it("reads an exact byte range and truncates cleanly at EOF", async () => {
    const key = await store.put(bytes("zero one two"))
    expect(str(await store.getRange(key, { offset: 5, length: 3 }))).toBe("one")
    expect(str(await store.getRange(key, { offset: 9, length: 20 }))).toBe("two")
    expect(await store.getRange(key, { offset: 99, length: 3 })).toEqual(new Uint8Array())
    expect(await store.getRange("bad", { offset: 0, length: 1 })).toBeNull()
    await expect(store.getRange(key, { offset: -1, length: 1 })).rejects.toThrow(RangeError)
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

  it("passes an offset range to the binding and rejects oversized responses", async () => {
    const calls: { offset: number; length: number }[] = []
    const ranged = new R2BlobStore({
      ...bucket,
      get: async (key, options) => {
        const value = map.get(key)
        if (!value) return null
        if (!options) return { arrayBuffer: async () => value.slice().buffer }
        calls.push(options.range)
        const { offset, length } = options.range
        const body = value.slice(offset, offset + length)
        return { arrayBuffer: async () => body.buffer }
      },
    })
    const key = await ranged.put(bytes("edge range bytes"))
    expect(str(await ranged.getRange(key, { offset: 5, length: 5 }))).toBe("range")
    expect(calls).toEqual([{ offset: 5, length: 5 }])
    expect(await ranged.getRange("bad", { offset: 0, length: 1 })).toBeNull()
    await expect(ranged.getRange(key, { offset: 0.5, length: 1 })).rejects.toThrow(RangeError)
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

  it("requests and validates a partial byte response", async () => {
    const calls: { headers: Record<string, string> }[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push({ headers: init.headers as Record<string, string> })
        return new Response(bytes("range"), {
          status: 206,
          headers: { "content-range": "bytes 5-9/16" },
        })
      }),
    )
    expect(str(await store.getRange("a".repeat(64), { offset: 5, length: 5 }))).toBe("range")
    expect(calls[0]?.headers.range).toBe("bytes=5-9")
  })

  it("rejects ignored or malformed range responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes("whole"), { status: 200 })),
    )
    await expect(store.getRange("a".repeat(64), { offset: 2, length: 3 })).rejects.toThrow(
      /range get .* failed: 200/,
    )

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(bytes("bad"), {
            status: 206,
            headers: { "content-range": "bytes 3-5/16" },
          }),
      ),
    )
    await expect(store.getRange("a".repeat(64), { offset: 2, length: 3 })).rejects.toThrow(
      /invalid Content-Range/,
    )
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
