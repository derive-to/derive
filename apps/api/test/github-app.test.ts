import { createHmac, createVerify, generateKeyPairSync } from "node:crypto"
import { describe, expect, it } from "vitest"
import { appJwt, verifyWebhookSignature } from "../src/lib/github-app"

// A throwaway RSA keypair, PKCS#1 PEM — the exact format GitHub's manifest
// conversion hands back, so this also proves createPrivateKey accepts it.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
})

const decode = (seg: string) => JSON.parse(Buffer.from(seg, "base64url").toString("utf8"))

describe("appJwt", () => {
  it("signs a verifiable RS256 JWT with the App id as issuer", () => {
    const jwt = appJwt("12345", privateKey, 1_000_000)
    const [header, payload, sig] = jwt.split(".")
    expect(decode(header as string)).toEqual({ alg: "RS256", typ: "JWT" })
    expect(decode(payload as string)).toEqual({
      iat: 1_000_000 - 60,
      exp: 1_000_000 + 540,
      iss: "12345",
    })
    const ok = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(sig as string, "base64url"))
    expect(ok).toBe(true)
  })
})

describe("verifyWebhookSignature", () => {
  const secret = "whsec_test"
  // sha256 HMAC of "hello" keyed by the secret, computed independently.
  it("accepts a correct signature and rejects everything else", () => {
    const body = JSON.stringify({ hello: "world" })
    // Round-trip: sign via the same HMAC the verifier expects.
    const good = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
    expect(verifyWebhookSignature(body, good, secret)).toBe(true)
    expect(verifyWebhookSignature(body, good, "wrong-secret")).toBe(false)
    expect(verifyWebhookSignature(`${body} `, good, secret)).toBe(false)
    expect(verifyWebhookSignature(body, undefined, secret)).toBe(false)
    expect(verifyWebhookSignature(body, "sha256=deadbeef", secret)).toBe(false)
  })
})
