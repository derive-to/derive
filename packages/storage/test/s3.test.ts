import { afterEach, describe, expect, it, vi } from "vitest"
import { type S3BlobStore, s3FromUrl } from "../src/s3"

const cfgOf = (store: S3BlobStore) => (store as unknown as { cfg: Record<string, unknown> }).cfg
const KEY = "a".repeat(64)

describe("s3FromUrl", () => {
  it("AWS endpoint: virtual-hosted-style, region read from the host", () => {
    const store = s3FromUrl("s3://AK:SECRET@s3.us-west-2.amazonaws.com/derive")
    expect(cfgOf(store)).toMatchObject({
      endpoint: "s3.us-west-2.amazonaws.com",
      bucket: "derive",
      region: "us-west-2",
      tls: true,
      pathStyle: false,
    })
    // bucket.host/key, the form AWS prefers
    expect(store.target(KEY).url).toBe(`https://derive.s3.us-west-2.amazonaws.com/${KEY}`)
  })

  it("global AWS endpoint defaults to us-east-1", () => {
    expect(cfgOf(s3FromUrl("s3://AK:SECRET@s3.amazonaws.com/derive"))).toMatchObject({
      region: "us-east-1",
      pathStyle: false,
    })
  })

  it("R2 endpoint: path-style, region auto, TLS on", () => {
    const store = s3FromUrl("s3://AK:SECRET@acct.r2.cloudflarestorage.com/derive?region=auto")
    expect(cfgOf(store)).toMatchObject({ region: "auto", tls: true, pathStyle: true })
    expect(store.target(KEY).url).toBe(`https://acct.r2.cloudflarestorage.com/derive/${KEY}`)
  })

  it("localhost (MinIO): path-style, TLS off, host/bucket/key", () => {
    const store = s3FromUrl("s3://minioadmin:minioadmin@localhost:9000/derive?region=us-east-1")
    expect(cfgOf(store)).toMatchObject({ endpoint: "localhost:9000", tls: false, pathStyle: true })
    expect(store.target(KEY).url).toBe(`http://localhost:9000/derive/${KEY}`)
  })

  it("?pathStyle= overrides the auto default", () => {
    expect(
      cfgOf(s3FromUrl("s3://AK:S@s3.us-east-1.amazonaws.com/derive?pathStyle=true")),
    ).toMatchObject({
      pathStyle: true,
    })
    expect(
      cfgOf(s3FromUrl("s3://AK:S@acct.r2.cloudflarestorage.com/derive?pathStyle=false")),
    ).toMatchObject({
      pathStyle: false,
    })
  })

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

  it("round-trips bytes through put then get", async () => {
    stubFetch()
    const key = await store.put(new TextEncoder().encode("hello s3"))
    expect(new TextDecoder().decode(await store.get(key))).toBe("hello s3")
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

  it("throws when get fails with a non-404 error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    )
    await expect(store.get("c".repeat(64))).rejects.toThrow(/s3 get .* failed: 500/)
  })
})
