import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex")

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
