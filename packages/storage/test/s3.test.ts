import { describe, expect, it } from "vitest"
import { S3BlobStore, s3FromUrl } from "../src/s3"

const cfgOf = (store: S3BlobStore) => (store as unknown as { cfg: Record<string, unknown> }).cfg
const KEY = "a".repeat(64)

describe("s3FromUrl", () => {
  it("AWS endpoint: virtual-hosted-style, region read from the host", () => {
    const store = s3FromUrl("s3://AK:SECRET@s3.us-west-2.amazonaws.com/dock")
    expect(cfgOf(store)).toMatchObject({
      endpoint: "s3.us-west-2.amazonaws.com",
      bucket: "dock",
      region: "us-west-2",
      tls: true,
      pathStyle: false,
    })
    // bucket.host/key, the form AWS prefers
    expect(store.target(KEY).url).toBe(`https://dock.s3.us-west-2.amazonaws.com/${KEY}`)
  })

  it("global AWS endpoint defaults to us-east-1", () => {
    expect(cfgOf(s3FromUrl("s3://AK:SECRET@s3.amazonaws.com/dock"))).toMatchObject({
      region: "us-east-1",
      pathStyle: false,
    })
  })

  it("R2 endpoint: path-style, region auto, TLS on", () => {
    const store = s3FromUrl("s3://AK:SECRET@acct.r2.cloudflarestorage.com/dock?region=auto")
    expect(cfgOf(store)).toMatchObject({ region: "auto", tls: true, pathStyle: true })
    expect(store.target(KEY).url).toBe(`https://acct.r2.cloudflarestorage.com/dock/${KEY}`)
  })

  it("localhost (MinIO): path-style, TLS off, host/bucket/key", () => {
    const store = s3FromUrl("s3://minioadmin:minioadmin@localhost:9000/dock?region=us-east-1")
    expect(cfgOf(store)).toMatchObject({ endpoint: "localhost:9000", tls: false, pathStyle: true })
    expect(store.target(KEY).url).toBe(`http://localhost:9000/dock/${KEY}`)
  })

  it("?pathStyle= overrides the auto default", () => {
    expect(cfgOf(s3FromUrl("s3://AK:S@s3.us-east-1.amazonaws.com/dock?pathStyle=true"))).toMatchObject({
      pathStyle: true,
    })
    expect(cfgOf(s3FromUrl("s3://AK:S@acct.r2.cloudflarestorage.com/dock?pathStyle=false"))).toMatchObject({
      pathStyle: false,
    })
  })

  it("rejects a URL with no bucket", () => {
    expect(() => s3FromUrl("s3://AK:SECRET@host.example.com/")).toThrow(/bucket/)
  })
})
