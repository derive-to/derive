import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto"

/** scrypt password hashing — `salt:hash` hex. Node-only (the container). */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(pw, salt, 32)
  return `${salt.toString("hex")}:${hash.toString("hex")}`
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":")
  if (!saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, "hex")
  const actual = scryptSync(pw, Buffer.from(saltHex, "hex"), 32)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export const newSessionToken = (): string => randomBytes(32).toString("hex")

export const SESSION_DAYS = 30
export const sessionExpiry = (now: number): string =>
  new Date(now + SESSION_DAYS * 86_400_000).toISOString()
