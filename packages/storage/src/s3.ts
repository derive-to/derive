import { createHash, createHmac } from "node:crypto"
import { sha256Hex, type BlobStore } from "@dock/core"

/**
 * S3-compatible blob store for the Node container — covers AWS S3, Cloudflare
 * R2, MinIO, GCS, anything that speaks the S3 REST API. Path-style addressing
 * (https://endpoint/bucket/key) so one code path serves every provider, and a
 * self-contained SigV4 signer over fetch so there's no AWS SDK dependency.
 *
 * Keys are content-addressed (sha256 of the bytes), matching the fs and R2
 * drivers, so the same artifact dedupes across stores.
 */
export interface S3Config {
  endpoint: string // host[:port], no scheme
  bucket: string
  accessKey: string
  secretKey: string
  region: string
  tls: boolean
}

const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex")
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest()

export class S3BlobStore implements BlobStore {
  constructor(private cfg: S3Config) {}

  private origin(): string {
    return `${this.cfg.tls ? "https" : "http"}://${this.cfg.endpoint}`
  }

  /** SigV4-sign a request for an object key and return headers + URL. */
  private sign(method: "PUT" | "GET", key: string, payloadHash: string) {
    const { bucket, region, accessKey, secretKey } = this.cfg
    const path = `/${bucket}/${enc(key)}`
    const now = new Date()
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "")
    const date = amzDate.slice(0, 8)
    const host = this.cfg.endpoint

    const canonicalHeaders =
      `host:${host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date"
    const canonicalRequest = [
      method,
      path,
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n")

    const scope = `${date}/${region}/s3/aws4_request`
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hash(canonicalRequest)].join("\n")

    const kDate = hmac(`AWS4${secretKey}`, date)
    const kRegion = hmac(kDate, region)
    const kService = hmac(kRegion, "s3")
    const kSigning = hmac(kService, "aws4_request")
    const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex")

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`

    return {
      url: `${this.origin()}${path}`,
      headers: {
        host,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        authorization,
      },
    }
  }

  async put(data: Uint8Array): Promise<string> {
    const key = await sha256Hex(data)
    const payloadHash = hash(data)
    const { url, headers } = this.sign("PUT", key, payloadHash)
    // Copy into a plain ArrayBuffer — an unambiguous BodyInit across TS lib versions.
    const body = new ArrayBuffer(data.byteLength)
    new Uint8Array(body).set(data)
    const res = await fetch(url, { method: "PUT", headers, body })
    if (!res.ok) throw new Error(`s3 put ${key} failed: ${res.status} ${await res.text()}`)
    return key
  }

  async get(key: string): Promise<Uint8Array | null> {
    if (!/^[0-9a-f]{64}$/.test(key)) return null
    const { url, headers } = this.sign("GET", key, hash(""))
    const res = await fetch(url, { method: "GET", headers })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`s3 get ${key} failed: ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }
}

/**
 * Parse OBJECT_STORE_URL into a config:
 *   s3://ACCESS_KEY:SECRET_KEY@endpoint[:port]/bucket?region=auto&tls=false
 * TLS defaults on (off only when tls=false or the host is localhost).
 */
export function s3FromUrl(raw: string): S3BlobStore {
  const url = new URL(raw)
  const bucket = url.pathname.replace(/^\//, "").split("/")[0]
  if (!bucket) throw new Error("OBJECT_STORE_URL must include a /bucket path")
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1"
  const tls = url.searchParams.get("tls") === "false" ? false : !local
  return new S3BlobStore({
    endpoint: url.host,
    bucket,
    accessKey: decodeURIComponent(url.username),
    secretKey: decodeURIComponent(url.password),
    region: url.searchParams.get("region") ?? "auto",
    tls,
  })
}
