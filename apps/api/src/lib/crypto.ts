import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex")

// --- symmetric encryption for secrets at rest (e.g. GitHub PATs) ------------
// AES-256-GCM with a key derived (domain-separated) from a server passphrase.
// Format: `v1.<iv>.<authTag>.<ciphertext>`, all base64url. decryptSecret
// tolerates a plaintext value (no `v1.` prefix) so a secret stored before a key
// was configured still reads back — it just wasn't encrypted. Runs on Node and
// the Cloudflare Worker (node:crypto + Buffer under nodejs_compat).
const encKey = (passphrase: string): Buffer =>
  createHash("sha256").update(`dock-secret-enc:${passphrase}`).digest()

export const encryptSecret = (plain: string, passphrase: string): string => {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", encKey(passphrase), iv)
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ct.toString("base64url")}`
}

export const decryptSecret = (blob: string, passphrase: string): string => {
  if (!blob.startsWith("v1.")) return blob // stored before encryption was configured
  const [, ivB, tagB, ctB] = blob.split(".")
  if (!ivB || !tagB || !ctB) return blob
  try {
    const d = createDecipheriv("aes-256-gcm", encKey(passphrase), Buffer.from(ivB, "base64url"))
    d.setAuthTag(Buffer.from(tagB, "base64url"))
    return Buffer.concat([d.update(Buffer.from(ctB, "base64url")), d.final()]).toString("utf8")
  } catch {
    return blob // wrong key / corrupt — fail the GitHub call rather than throw here
  }
}

// Constant-time string compare: hash both sides to a fixed length first so
// neither the contents nor the length leak through comparison timing. An unset
// secret (undefined) never matches.
export const safeEqual = (a: string, b: string | undefined): boolean =>
  !!b &&
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest())

// --- password-protected artifacts -----------------------------------------
// The unlock password is a shared link secret, not an account credential, so it
// follows the same hashed-at-rest model as agent tokens — but salted, so a DB
// leak can't rainbow-table common passwords. Stored as `salt.sha256(salt+pw)`.
export const hashPassword = (password: string): string => {
  const salt = randomBytes(9).toString("base64url")
  return `${salt}.${sha256(salt + password)}`
}
export const verifyPassword = (password: string, stored: string | null | undefined): boolean => {
  const [salt, digest] = (stored ?? "").split(".")
  return !!salt && !!digest && safeEqual(sha256(salt + password), digest)
}

// The cookie that proves a visitor has unlocked one artifact. Its value is
// derived from the server-only password hash, so a client can't forge it without
// the password, and it auto-invalidates if the password changes.
export const unlockCookie = (shortId: string): string => `dku_${shortId}`
export const unlockToken = (artifactId: string, passwordHash: string): string =>
  sha256(`${artifactId}:${passwordHash}`)
