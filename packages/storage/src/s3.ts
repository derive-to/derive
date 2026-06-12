import { createHash, createHmac } from "node:crypto"
import { sha256Hex, type BlobStore } from "@dock/core"

/**
 * S3-compatible blob store for the Node container — covers AWS S3, Cloudflare
 * R2, MinIO, GCS, anything that speaks the S3 REST API. A self-contained SigV4
 * signer over fetch, so there's no AWS SDK dependency.
 *
 * Addressing is virtual-hosted-style for AWS (bucket.host/key, the form AWS now
 * prefers) and path-style elsewhere (host/bucket/key, what MinIO/R2/local need).
 * It's auto-selected from the endpoint and overridable with ?pathStyle=.
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
  pathStyle: boolean
}

const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex")
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest()

export class S3BlobStore implements BlobStore {
  constructor(private cfg: S3Config) {}

  /** Resolve the request host and canonical path for an object key. */
  target(key: string): { host: string; path: string; url: string } {
    const { endpoint, bucket, pathStyle, tls } = this.cfg
    const host = pathStyle ? endpoint : `${bucket}.${endpoint}`
    const path = pathStyle ? `/${bucket}/${enc(key)}` : `/${enc(key)}`
    return { host, path, url: `${tls ? "https" : "http"}://${host}${path}` }
  }

  /** SigV4-sign a request for an object key and return headers + URL. */
  private sign(method: "PUT" | "GET", key: string, payloadHash: string) {
    const { region, accessKey, secretKey } = this.cfg
    const { host, path, url } = this.target(key)
    const now = new Date()
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "")
    const date = amzDate.slice(0, 8)

    const canonicalHeaders =
      `host:${host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date"
    const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, payloadHash].join(
      "\n",
    )

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
      url,
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

/** Pull the AWS region out of an S3 endpoint host (s3.<region>.amazonaws.com). */
const awsRegion = (hostname: string): string => {
  if (hostname === "s3.amazonaws.com") return "us-east-1"
  const m = hostname.match(/^s3[.-]([a-z0-9-]+?)\.amazonaws\.com$/i)
  return m ? m[1] : "us-east-1"
}

/**
 * Parse OBJECT_STORE_URL into a config:
 *   s3://ACCESS_KEY:SECRET_KEY@endpoint[:port]/bucket?region=...&tls=...&pathStyle=...
 *
 * Defaults are picked from the endpoint:
 *   - AWS (*.amazonaws.com): virtual-hosted-style, region read from the host.
 *   - everything else (R2, MinIO, ...): path-style, region "auto".
 *   - TLS on unless tls=false or the host is localhost.
 */
export function s3FromUrl(raw: string): S3BlobStore {
  const url = new URL(raw)
  const bucket = url.pathname.replace(/^\//, "").split("/")[0]
  if (!bucket) throw new Error("OBJECT_STORE_URL must include a /bucket path")

  const isAws = /\.amazonaws\.com$/i.test(url.hostname)
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1"
  const tls = url.searchParams.get("tls") === "false" ? false : !local
  const pathStyleParam = url.searchParams.get("pathStyle")
  const pathStyle = pathStyleParam != null ? pathStyleParam !== "false" : !isAws
  const region =
    url.searchParams.get("region") ?? (isAws ? awsRegion(url.hostname) : "auto")

  return new S3BlobStore({
    endpoint: url.host,
    bucket,
    accessKey: decodeURIComponent(url.username),
    secretKey: decodeURIComponent(url.password),
    region,
    tls,
    pathStyle,
  })
}
