/**
 * Short-lived HMAC-SHA256 preview-access tokens for the /raw/:shortId/v/:n/*
 * route. Used by the screenshot renderer to load private/gated artifacts
 * without embedding long-lived credentials.
 *
 * Format: `<payload>.<signature>`
 *   payload  = base64url(`<artifactId>.<n>.<expEpochMs>`)
 *   signature = base64url(HMAC-SHA256(key, payload))
 *
 * Edge-safe: uses Web Crypto (crypto.subtle) only — no node:crypto. Works on
 * Node 24 and Cloudflare Workers without nodejs_compat.
 *
 * Both exported functions are async (crypto.subtle.sign returns a Promise).
 * Callers must await them; the minting task must also await signPreviewToken.
 */

const DOMAIN = "derive-preview-token:"

/** Import a signing key from the raw secret string (domain-separated). */
const importKey = async (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${DOMAIN}${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  )

/** Encode a Uint8Array to base64url (no padding). */
const toBase64Url = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf)
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

/** Decode a base64url string to Uint8Array. Returns null on invalid input. */
const fromBase64Url = (s: string): Uint8Array | null => {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/")
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4)
    const bin = atob(padded)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/**
 * Sign a preview token that authorizes read of exactly one artifact+version.
 *
 * @param secret      The DERIVE_AUTH_SECRET / encryptionKey
 * @param artifactId  The canonical artifact UUID (not the shortId)
 * @param n           The version number (1-based integer)
 * @param expEpochMs  Expiry as ms since epoch (Date.now() + ttl)
 * @returns           A compact opaque token string (async — must be awaited)
 */
export const signPreviewToken = async (
  secret: string,
  artifactId: string,
  n: number,
  expEpochMs: number,
): Promise<string> => {
  const encoded = new TextEncoder().encode(`${artifactId}.${n}.${expEpochMs}`)
  const payload = toBase64Url(encoded.buffer as ArrayBuffer)
  const key = await importKey(secret)
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))
  return `${payload}.${toBase64Url(sig)}`
}

/**
 * Verify a preview token. Returns the artifact id + version if valid, or null.
 *
 * Constant-time: uses crypto.subtle.verify so the HMAC comparison is timing-safe.
 *
 * @param secret  The DERIVE_AUTH_SECRET / encryptionKey
 * @param token   The token string produced by signPreviewToken
 * @param nowMs   Current time in ms (Date.now()); injectable for testing
 * @returns       { artifactId, n } if valid and not expired, else null (async)
 */
export const verifyPreviewToken = async (
  secret: string,
  token: string,
  nowMs: number,
): Promise<{ artifactId: string; n: number } | null> => {
  const dot = token.lastIndexOf(".")
  if (dot <= 0) return null
  const payload = token.slice(0, dot)
  const sigB64 = token.slice(dot + 1)

  const sigBytes = fromBase64Url(sigB64)
  if (!sigBytes) return null

  let key: CryptoKey
  try {
    key = await importKey(secret)
  } catch {
    return null
  }

  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    new Uint8Array(sigBytes),
    new TextEncoder().encode(payload),
  )
  if (!valid) return null

  const plainBytes = fromBase64Url(payload)
  if (!plainBytes) return null
  const plain = new TextDecoder().decode(plainBytes)

  // Format: `<artifactId>.<n>.<expEpochMs>`
  // artifactId may contain hyphens but not dots; n and expEpochMs are integers.
  // Split from the right so artifactId is allowed to contain dots (defensive).
  const lastDot = plain.lastIndexOf(".")
  if (lastDot <= 0) return null
  const expStr = plain.slice(lastDot + 1)
  const rest = plain.slice(0, lastDot)
  const midDot = rest.lastIndexOf(".")
  if (midDot <= 0) return null
  const nStr = rest.slice(midDot + 1)
  const artifactId = rest.slice(0, midDot)

  const expEpochMs = Number(expStr)
  const n = Number(nStr)
  if (!Number.isFinite(expEpochMs) || !Number.isInteger(n)) return null
  if (nowMs >= expEpochMs) return null

  return { artifactId, n }
}
