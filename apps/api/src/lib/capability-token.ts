/**
 * The shared core of the short-lived HMAC-SHA256 capability tokens: a signed,
 * expiring proof that its holder may do ONE narrow thing, spendable without a
 * session. Each token kind gets its own domain string, so a token of one kind
 * can never be replayed as another — the domains are as much a part of the key
 * as the secret. Current kinds:
 *
 *   - lib/preview-token.ts  ("derive-preview-token:") — read one artifact+version;
 *     minted for the screenshot renderer.
 *   - lib/upload-token.ts   ("derive-upload-token:") — stage assets into one
 *     workspace; minted by the MCP stage_asset tool.
 *
 * (lib/crypto.ts's signState is the third, older signed-state format — node:crypto
 * based, used for the OAuth install flow and raw_tokens. New capability tokens
 * should be built on this file instead.)
 *
 * Format: `<payload>.<signature>`
 *   payload  = base64url(`<field1>.<field2>...<expEpochMs>`) — expiry is ALWAYS
 *              the last dot-separated field; earlier fields are the kind's own.
 *   signature = base64url(HMAC-SHA256(key, payload))
 *
 * Edge-safe: Web Crypto (crypto.subtle) only — no node:crypto, no Buffer. Works
 * on Node 24 and Cloudflare Workers without nodejs_compat. Both functions are
 * async (crypto.subtle returns Promises).
 */

// One key-schedule per (domain, secret) per process: importKey re-derivation is
// pure repeated work, and verify runs on hot unauthenticated paths (every nested
// asset request of a preview render; every tokened upload POST).
const keyCache = new Map<string, Promise<CryptoKey>>()

const importKey = (domain: string, secret: string): Promise<CryptoKey> => {
  const cacheKey = `${domain} ${secret}`
  let key = keyCache.get(cacheKey)
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(`${domain}${secret}`),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    )
    keyCache.set(cacheKey, key)
  }
  return key
}

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
 * Sign a capability token: `fields` joined with dots, expiry appended as the
 * final field, HMAC'd under the domain-separated key.
 *
 * The LAST field is the only one recovered structurally on verify — earlier
 * fields are rejoined verbatim, so a kind with several fields splits them
 * itself (and must pick separators its field values can't contain).
 */
export const signCapabilityToken = async (
  domain: string,
  secret: string,
  fields: string[],
  expEpochMs: number,
): Promise<string> => {
  const encoded = new TextEncoder().encode([...fields, expEpochMs].join("."))
  const payload = toBase64Url(encoded.buffer as ArrayBuffer)
  const key = await importKey(domain, secret)
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))
  return `${payload}.${toBase64Url(sig)}`
}

/**
 * Verify a capability token. Returns the payload with expiry split back off —
 * `rest` is everything before the final dot (the sign-time fields, still
 * joined) — or null on any failure: bad encoding, bad signature, expired.
 * Never throws; constant-time signature comparison via crypto.subtle.verify.
 */
export const verifyCapabilityToken = async (
  domain: string,
  secret: string,
  token: string,
  nowMs: number,
): Promise<{ rest: string } | null> => {
  const dot = token.lastIndexOf(".")
  if (dot <= 0) return null
  const payload = token.slice(0, dot)
  const sigBytes = fromBase64Url(token.slice(dot + 1))
  if (!sigBytes) return null

  let key: CryptoKey
  try {
    key = await importKey(domain, secret)
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

  // Expiry is always the last dot-separated field; the rest is the kind's own.
  const lastDot = plain.lastIndexOf(".")
  if (lastDot <= 0) return null
  const expEpochMs = Number(plain.slice(lastDot + 1))
  if (!Number.isFinite(expEpochMs) || nowMs >= expEpochMs) return null

  return { rest: plain.slice(0, lastDot) }
}
