import { afterEach, describe, expect, it, vi } from "vitest"
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  isBreachedPassword,
  safeEqual,
  sha256,
  signState,
  unlockCookie,
  unlockToken,
  verifyPassword,
  verifyState,
} from "../src/lib/crypto"

describe("sha256", () => {
  it("matches known SHA-256 vectors (hex)", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })
})

describe("signState / verifyState — signed, expiring state tokens", () => {
  const secret = "server-secret"
  const T = 1_700_000_000_000

  it("round-trips the payload and stamps iat", () => {
    const token = signState({ org: "o1", user: "u1" }, secret, T)
    const out = verifyState<{ org: string; user: string; iat: number }>(token, secret, undefined, T)
    expect(out).toMatchObject({ org: "o1", user: "u1", iat: T })
  })

  it("rejects a tampered body or signature", () => {
    const token = signState({ org: "o1" }, secret, T)
    const [body, sig] = token.split(".")
    expect(verifyState(`${body}x.${sig}`, secret, undefined, T)).toBeNull()
    expect(verifyState(`${body}.${sig}x`, secret, undefined, T)).toBeNull()
  })

  it("rejects a token signed with a different secret (binds to the auth secret)", () => {
    const token = signState({ org: "o1" }, secret, T)
    expect(verifyState(token, "other-secret", undefined, T)).toBeNull()
  })

  it("rejects an expired token and one with a future iat (clock-skew guard)", () => {
    const maxAge = 15 * 60_000
    const token = signState({ org: "o1" }, secret, T)
    // Verified just past the window -> expired.
    expect(verifyState(token, secret, maxAge, T + maxAge + 1)).toBeNull()
    // A token whose iat is well in the future of the verifier -> rejected.
    const future = signState({ org: "o1" }, secret, T + 120_000)
    expect(verifyState(future, secret, maxAge, T)).toBeNull()
  })

  it("returns null for a malformed token", () => {
    expect(verifyState("nodot", secret)).toBeNull()
    expect(verifyState("a.b.c", secret)).toBeNull()
  })
})

describe("encryptSecret / decryptSecret — AES-256-GCM at rest", () => {
  const pass = "passphrase"

  it("round-trips, including unicode", () => {
    const blob = encryptSecret("ghp_secret-token", pass)
    expect(decryptSecret(blob, pass)).toBe("ghp_secret-token")
    expect(decryptSecret(encryptSecret("héllo 🔒", pass), pass)).toBe("héllo 🔒")
  })

  it("produces a v1 envelope with a 12-byte IV that hides the plaintext", () => {
    const parts = encryptSecret("topsecret", pass).split(".")
    expect(parts[0]).toBe("v1")
    expect(parts).toHaveLength(4) // v1.iv.tag.ciphertext
    // A 12-byte GCM IV is embedded — 12 bytes is exactly 16 base64url chars (no
    // padding). The round-trip test proves decryption uses it; freshness per call
    // is node's randomBytes contract, not ours.
    expect(parts[1]).toMatch(/^[\w-]{16}$/)
    expect(parts.join(".")).not.toContain("topsecret")
  })

  it("does not reveal the plaintext under a wrong key or tampering (fails closed)", () => {
    const blob = encryptSecret("topsecret", pass)
    // Wrong key: returns the (still-encrypted) blob, never the plaintext.
    expect(decryptSecret(blob, "wrong")).not.toBe("topsecret")
    // Tampered ciphertext fails the GCM auth tag and is not decoded to plaintext.
    //
    // The mutation has to be GUARANTEED different. Overwriting the last characters with a fixed
    // string ("…AA") silently tampers with nothing on the runs where the ciphertext already ends
    // that way — the blob is then byte-identical, decrypts perfectly, and this test fails while
    // reporting that GCM is broken. Rare, random, and observed in CI. Flip relative to what is
    // actually there instead.
    const p = blob.split(".")
    const ct = p[3] ?? ""
    const flipped = ct.slice(-1) === "A" ? "B" : "A"
    const tampered = `${p.slice(0, 3).join(".")}.${ct.slice(0, -1)}${flipped}`
    expect(tampered).not.toBe(blob)
    expect(decryptSecret(tampered, pass)).not.toBe("topsecret")
  })

  it("passes through a value stored before encryption was configured", () => {
    expect(decryptSecret("plain-legacy-value", pass)).toBe("plain-legacy-value")
  })
})

describe("hashPassword / verifyPassword — salted, hashed at rest", () => {
  it("verifies the right password and rejects the wrong one", () => {
    const stored = hashPassword("hunter2")
    expect(verifyPassword("hunter2", stored)).toBe(true)
    expect(verifyPassword("Hunter2", stored)).toBe(false)
  })

  it("stores a salt alongside the sha256 digest, and verifies against it", () => {
    const [salt, digest] = hashPassword("same").split(".")
    expect(salt).toBeTruthy() // a per-hash salt is prepended (its randomness is node's job)
    expect(digest).toMatch(/^[0-9a-f]{64}$/) // sha256 hex
    expect(verifyPassword("same", hashPassword("same"))).toBe(true)
  })

  it("rejects null / empty / malformed stored values", () => {
    for (const bad of [null, undefined, "", "nodot", "salt.", ".digest"])
      expect(verifyPassword("x", bad)).toBe(false)
  })
})

describe("safeEqual — constant-time compare", () => {
  it("is true only for equal strings, and never for an unset/empty secret", () => {
    expect(safeEqual("token", "token")).toBe(true)
    expect(safeEqual("token", "tokeN")).toBe(false)
    expect(safeEqual("token", undefined)).toBe(false)
    // An empty secret is treated as unset and never matches (even an empty input).
    expect(safeEqual("", "")).toBe(false)
  })
})

describe("unlock tokens", () => {
  it("derives a deterministic unlock token that invalidates when the hash changes", () => {
    const t1 = unlockToken("art1", "hashA")
    expect(unlockToken("art1", "hashA")).toBe(t1) // stable
    expect(unlockToken("art1", "hashB")).not.toBe(t1) // password changed -> cookie invalid
    expect(unlockToken("art2", "hashA")).not.toBe(t1) // per-artifact
  })

  it("names the unlock cookie per artifact", () => {
    expect(unlockCookie("ab12cd34")).toBe("dku_ab12cd34")
  })
})

describe("isBreachedPassword (HIBP k-anonymity, fail-open)", () => {
  afterEach(() => vi.restoreAllMocks())

  // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8 → prefix 5BAA6, suffix …68FD8.
  const suffixOf = "1E4C9B93F3F0682250B6CF8331B7EE68FD8"

  it("rejects a password whose suffix is in the range response (count > 0)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(`00000000000000000000000000000000000:5\r\n${suffixOf}:42`, { status: 200 }),
    )
    expect(await isBreachedPassword("password")).toBe(true)
  })

  it("allows a password absent from the range response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("00000000000000000000000000000000000:5", { status: 200 }),
    )
    expect(await isBreachedPassword("a-unique-passphrase-xyz")).toBe(false)
  })

  it("ignores padded (count 0) entries so synthetic padding never falsely rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(`${suffixOf}:0`, { status: 200 }))
    expect(await isBreachedPassword("password")).toBe(false)
  })

  it("FAILS OPEN on a network error (air-gapped self-host is never blocked)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ENETUNREACH"))
    expect(await isBreachedPassword("password")).toBe(false)
  })

  it("fails open on a non-200 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 503 }))
    expect(await isBreachedPassword("password")).toBe(false)
  })
})
