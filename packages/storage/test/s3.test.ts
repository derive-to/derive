import { describe, expect, it } from "vitest"
import { S3BlobStore, s3FromUrl } from "../src/s3"

describe("s3FromUrl", () => {
  it("parses an R2-style URL with TLS on by default", () => {
    const store = s3FromUrl(
      "s3://AK:SECRET@acct.r2.cloudflarestorage.com/dock?region=auto",
    )
    expect(store).toBeInstanceOf(S3BlobStore)
    const cfg = (store as unknown as { cfg: Record<string, unknown> }).cfg
    expect(cfg).toMatchObject({
      endpoint: "acct.r2.cloudflarestorage.com",
      bucket: "dock",
      accessKey: "AK",
      secretKey: "SECRET",
      region: "auto",
      tls: true,
    })
  })

  it("turns TLS off for localhost and honours tls=false", () => {
    const cfg = (
      s3FromUrl("s3://minioadmin:minioadmin@localhost:9000/dock?region=us-east-1") as unknown as {
        cfg: Record<string, unknown>
      }
    ).cfg
    expect(cfg).toMatchObject({ endpoint: "localhost:9000", tls: false, region: "us-east-1" })
  })

  it("rejects a URL with no bucket", () => {
    expect(() => s3FromUrl("s3://AK:SECRET@host.example.com/")).toThrow(/bucket/)
  })
})
