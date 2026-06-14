import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { FsBlobStore } from "../src/fs"
import { R2BlobStore, type R2Like } from "../src/r2"

const bytes = (s: string) => new TextEncoder().encode(s)
const str = (u: Uint8Array | null) => (u ? new TextDecoder().decode(u) : null)
const SHA_RE = /^[0-9a-f]{64}$/

// Both content-addressed stores share the BlobStore contract: put returns a sha256
// hex key, get round-trips, a malformed key is rejected without a backend call, and
// a well-formed-but-absent key is null (not an error).
describe("FsBlobStore (local disk, the default store)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dock-blobs-"))
  const store = new FsBlobStore(dir)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("puts content-addressed and round-trips it", async () => {
    const key = await store.put(bytes("hello world"))
    expect(key).toMatch(SHA_RE)
    expect(str(await store.get(key))).toBe("hello world")
  })

  it("dedupes identical bytes to the same key (idempotent put)", async () => {
    const a = await store.put(bytes("same"))
    const b = await store.put(bytes("same")) // hits the existsSync short-circuit
    expect(a).toBe(b)
  })

  it("rejects a malformed key and returns null for a missing one", async () => {
    expect(await store.get("not-a-key")).toBeNull()
    expect(await store.get("a".repeat(64))).toBeNull() // valid shape, absent
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
})
