import { createHmac, createVerify, generateKeyPairSync } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { signState, verifyState } from "../src/lib/crypto"
import {
  appJwt,
  convertManifestCode,
  installationToken,
  verifyWebhookSignature,
} from "../src/lib/github-app"

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

describe("installationToken + convertManifestCode", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("mints, caches, and returns the installation token", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: "ghs_inst",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)
    const t1 = await installationToken("12345", privateKey, "999")
    const t2 = await installationToken("12345", privateKey, "999")
    expect(t1).toBe("ghs_inst")
    expect(t2).toBe("ghs_inst")
    // Second call served from cache (one network mint).
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("converts a manifest code into App credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 42,
              slug: "dock-on-acme",
              client_id: "Iv1.x",
              client_secret: "sek",
              pem: "-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----",
              webhook_secret: "whsec",
            }),
            { status: 200 },
          ),
      ),
    )
    const conv = await convertManifestCode("tmpcode")
    expect(conv).toMatchObject({ app_id: "42", slug: "dock-on-acme", webhook_secret: "whsec" })
  })
})

describe("signState / verifyState", () => {
  const secret = "server-secret"
  it("round-trips a payload, and rejects tampering + expiry", () => {
    const token = signState({ org: "ws_1", uid: "u_1" }, secret, 1_000_000)
    const ok = verifyState<{ org: string; uid: string }>(token, secret, 60_000, 1_000_030)
    expect(ok).toMatchObject({ org: "ws_1", uid: "u_1" })
    // Wrong key.
    expect(verifyState(token, "other", 60_000, 1_000_030)).toBeNull()
    // Expired (past maxAge).
    expect(verifyState(token, secret, 10_000, 1_100_000)).toBeNull()
    // Tampered body.
    const [, sig] = token.split(".")
    const forged = `${Buffer.from(JSON.stringify({ org: "ws_evil", iat: 1_000_000 })).toString("base64url")}.${sig}`
    expect(verifyState(forged, secret, 60_000, 1_000_030)).toBeNull()
  })
})
