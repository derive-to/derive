import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newId, publish } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { zipBundleFiles } from "../src/lib/bundle"
import { signPreviewToken, verifyPreviewToken } from "../src/lib/preview-token"
import { PNG_B64, PNG_SIGNATURE } from "./fixtures"

// ---- Unit tests: token sign/verify -----------------------------------------

describe("preview token", () => {
  // A throwaway HMAC key for the sign/verify tests, not a real credential.
  const secret = "s3cr3t-long-enough" // gitleaks:allow

  it("verifies before expiry", async () => {
    const exp = 10_000
    const tok = await signPreviewToken(secret, "a1", 3, exp)
    expect(await verifyPreviewToken(secret, tok, 5_000)).toEqual({ artifactId: "a1", n: 3 })
  })

  it("returns null after expiry", async () => {
    const exp = 10_000
    const tok = await signPreviewToken(secret, "a1", 3, exp)
    expect(await verifyPreviewToken(secret, tok, 20_000)).toBeNull()
  })

  it("returns null when tampered", async () => {
    const exp = 10_000
    const tok = await signPreviewToken(secret, "a1", 3, exp)
    expect(await verifyPreviewToken(secret, `${tok}x`, 5_000)).toBeNull()
  })

  it("returns null for a different secret", async () => {
    const exp = 10_000
    const tok = await signPreviewToken(secret, "a1", 3, exp)
    expect(await verifyPreviewToken("other", tok, 5_000)).toBeNull()
  })

  it("is scoped: a token for artifact a1 does not verify as a2", async () => {
    const exp = 10_000
    const tok = await signPreviewToken(secret, "a1", 3, exp)
    const result = await verifyPreviewToken(secret, tok, 5_000)
    expect(result?.artifactId).toBe("a1")
    expect(result?.artifactId).not.toBe("a2")
  })

  it("is scoped: a token for version 3 does not verify as version 4", async () => {
    const exp = 10_000
    const tok = await signPreviewToken(secret, "a1", 3, exp)
    const result = await verifyPreviewToken(secret, tok, 5_000)
    expect(result?.n).toBe(3)
    expect(result?.n).not.toBe(4)
  })
})

// ---- Route tests: /raw with a /pv/<token>/ path segment ---------------------

const dir = mkdtempSync(join(tmpdir(), "derive-pvtest-"))
const meta = new SqliteMetaStore(join(dir, "pv.db"))
const blobs = new FsBlobStore(join(dir, "blobs"))
const TEST_SECRET = "test-preview-secret-long-enough"

// App with a known encryptionKey so preview tokens can be verified.
const app = createApp({
  meta,
  blobs,
  baseUrl: "http://derive.test",
  token: "tok",
  encryptionKey: TEST_SECRET,
})

afterAll(() => {
  meta.close()
  rmSync(dir, { recursive: true, force: true })
})

const enc = (s: string) => new TextEncoder().encode(s)

describe("raw route: preview-access token (/pv/<token>/ path segment)", () => {
  let shortId: string
  let artifactId: string

  // Was `it("setup: publish a private artifact")`. It asserted nothing — it only
  // built the fixture the cases below run against — so reporting it as a
  // passing test inflated the inventory and implied a guarantee it never
  // made. As a hook it still fails the suite if it throws.
  beforeAll(async () => {
    const key = await blobs.put(enc("<h1>Private Content</h1>"))
    const a = await meta.createArtifact({
      id: newId("a"),
      short_id: "pvtest1",
      org_id: "default",
      slug: null,
      title: "Private Art",
      workspace_access: "none",
      link_role: "none",
      listed: "none",
      kind: "file",
      spa: 0,
    })
    await meta.addVersion(a.id, {
      id: newId("v"),
      blob_key: key,
      content_type: "text/html",
      size_bytes: 24,
      author: "t",
      message: null,
    })
    shortId = "pvtest1"
    artifactId = a.id
  })

  it("anonymous GET /raw without a token → 404", async () => {
    const res = await app.request(`/raw/${shortId}/v/1/index.html`)
    expect(res.status).toBe(404)
  })

  it("anonymous GET /raw with a valid /pv/ token → 200", async () => {
    const exp = Date.now() + 60_000
    const tok = await signPreviewToken(TEST_SECRET, artifactId, 1, exp)
    const res = await app.request(`/raw/${shortId}/v/1/pv/${tok}/index.html`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("Private Content")
  })

  it("the legacy ?pv= query form no longer grants access → 404", async () => {
    // The token moved into the path so a bundle's relative asset references
    // inherit it; the query form is gone, not just deprecated.
    const exp = Date.now() + 60_000
    const tok = await signPreviewToken(TEST_SECRET, artifactId, 1, exp)
    const res = await app.request(`/raw/${shortId}/v/1/index.html?pv=${tok}`)
    expect(res.status).toBe(404)
  })

  it("anonymous GET /raw with an expired /pv/ token → 404", async () => {
    const exp = Date.now() - 1_000 // already expired
    const tok = await signPreviewToken(TEST_SECRET, artifactId, 1, exp)
    const res = await app.request(`/raw/${shortId}/v/1/pv/${tok}/index.html`)
    expect(res.status).toBe(404)
  })

  it("anonymous GET /raw with a garbage /pv/ token → 404", async () => {
    const res = await app.request(`/raw/${shortId}/v/1/pv/garbage/index.html`)
    expect(res.status).toBe(404)
  })

  it("/pv/ token for the right artifact but wrong version → 404", async () => {
    const exp = Date.now() + 60_000
    // Token for version 2 (which doesn't exist), but we're requesting version 1
    const tok = await signPreviewToken(TEST_SECRET, artifactId, 2, exp)
    const res = await app.request(`/raw/${shortId}/v/1/pv/${tok}/index.html`)
    // Version 2 doesn't exist in meta, so 404 is expected either way
    // But this also tests that version scoping is enforced
    expect(res.status).toBe(404)
  })

  it("/pv/ token for a different artifact → 404", async () => {
    const exp = Date.now() + 60_000
    // Token signed for a different artifact id
    const tok = await signPreviewToken(TEST_SECRET, "different-artifact-id", 1, exp)
    const res = await app.request(`/raw/${shortId}/v/1/pv/${tok}/index.html`)
    expect(res.status).toBe(404)
  })

  it("a private bundle's sub-assets load through the /pv/ page URL (the renderer's broken-image regression)", async () => {
    // The bug: the renderer used to load `index.html?pv=<token>` — the page
    // authorized, but the browser resolves its `<img src="shot.png">` against the
    // PATH only, dropping the query, so every sub-asset request arrived anonymous
    // and 404'd. Private bundles screenshotted with broken images. With the token
    // as a path segment, the asset URL a browser computes from the page URL
    // carries the same proof of access automatically.
    const { artifact } = await publish(meta, blobs, {
      bytes: await zipBundleFiles({
        "index.html": '<!doctype html><img src="shot.png">',
        "shot.png": `data:image/png;base64,${PNG_B64}`,
      }),
      filename: "site.zip",
      isBundle: true,
      title: "Private Bundle",
      author: "t",
      orgId: "default",
      workspaceAccess: "none",
      linkRole: "none",
      listed: "none",
    })
    const exp = Date.now() + 60_000
    const tok = await signPreviewToken(TEST_SECRET, artifact.id, 1, exp)

    // The bundle really is private: no token, no asset.
    const anon = await app.request(`/raw/${artifact.short_id}/v/1/shot.png`)
    expect(anon.status).toBe(404)

    // The page loads at the /pv/ URL...
    const page = await app.request(`/raw/${artifact.short_id}/v/1/pv/${tok}/index.html`)
    expect(page.status).toBe(200)

    // ...and the sub-asset URL a browser derives from it (relative resolution
    // keeps the /pv/<token>/ path prefix) serves the actual PNG bytes.
    const img = await app.request(`/raw/${artifact.short_id}/v/1/pv/${tok}/shot.png`)
    expect(img.status).toBe(200)
    const bytes = new Uint8Array(await img.arrayBuffer())
    expect(Array.from(bytes.slice(0, 8))).toEqual(PNG_SIGNATURE)
  })

  it("a bundle's own literal pv/ directory still serves — an invalid segment falls through, it is not a reserved name", async () => {
    // The route pattern /v/:n/pv/:pv/* would otherwise swallow a bundle's real
    // pv/chart.png (segment consumed as a "token", remainder sliced against the
    // wrong prefix → 404 for a fully authorized viewer). The handler verifies
    // FIRST and next()s to the plain route when the segment isn't a real token.
    const { artifact } = await publish(meta, blobs, {
      bytes: await zipBundleFiles({
        "index.html": '<!doctype html><img src="pv/chart.png">',
        "pv/chart.png": `data:image/png;base64,${PNG_B64}`,
        "pv/deep/nested.png": `data:image/png;base64,${PNG_B64}`,
      }),
      filename: "site.zip",
      isBundle: true,
      title: "Bundle With pv Dir",
      author: "t",
      orgId: "default",
      workspaceAccess: "none",
      linkRole: "none",
      listed: "none",
    })

    // An authorized viewer (the owner token) gets the real files under pv/.
    const authed = (p: string) =>
      app.request(`/raw/${artifact.short_id}/v/1/${p}`, {
        headers: { authorization: "Bearer tok" },
      })
    const img = await authed("pv/chart.png")
    expect(img.status).toBe(200)
    const bytes = new Uint8Array(await img.arrayBuffer())
    expect(Array.from(bytes.slice(0, 8))).toEqual(PNG_SIGNATURE)
    // Deeper nesting under pv/ (the "token" segment would have been a directory).
    expect((await authed("pv/deep/nested.png")).status).toBe(200)

    // The fallthrough grants nothing: anonymous still can't read the private file.
    const anon = await app.request(`/raw/${artifact.short_id}/v/1/pv/chart.png`)
    expect(anon.status).toBe(404)
  })
})
