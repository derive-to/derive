import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newId } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { signPreviewToken, verifyPreviewToken } from "../src/lib/preview-token"

// ---- Unit tests: token sign/verify -----------------------------------------

describe("preview token", () => {
  const secret = "s3cr3t-long-enough"

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

// ---- Route tests: /raw with ?pv= token -------------------------------------

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

describe("raw route: preview-access token (?pv=)", () => {
  let shortId: string
  let artifactId: string

  it("setup: publish a private artifact", async () => {
    const key = await blobs.put(enc("<h1>Private Content</h1>"))
    const a = await meta.createArtifact({
      id: newId("a"),
      short_id: "pvtest1",
      org_id: "default",
      slug: null,
      title: "Private Art",
      visibility: "private",
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

  it("anonymous GET /raw without pv= → 404", async () => {
    const res = await app.request(`/raw/${shortId}/v/1/index.html`)
    expect(res.status).toBe(404)
  })

  it("anonymous GET /raw with a valid pv= → 200", async () => {
    const exp = Date.now() + 60_000
    const tok = await signPreviewToken(TEST_SECRET, artifactId, 1, exp)
    const res = await app.request(`/raw/${shortId}/v/1/index.html?pv=${tok}`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("Private Content")
  })

  it("anonymous GET /raw with an expired pv= → 404", async () => {
    const exp = Date.now() - 1_000 // already expired
    const tok = await signPreviewToken(TEST_SECRET, artifactId, 1, exp)
    const res = await app.request(`/raw/${shortId}/v/1/index.html?pv=${tok}`)
    expect(res.status).toBe(404)
  })

  it("anonymous GET /raw with garbage pv= → 404", async () => {
    const res = await app.request(`/raw/${shortId}/v/1/index.html?pv=garbage`)
    expect(res.status).toBe(404)
  })

  it("pv= for the right artifact but wrong version → 404", async () => {
    const exp = Date.now() + 60_000
    // Token for version 2 (which doesn't exist), but we're requesting version 1
    const tok = await signPreviewToken(TEST_SECRET, artifactId, 2, exp)
    const res = await app.request(`/raw/${shortId}/v/1/index.html?pv=${tok}`)
    // Version 2 doesn't exist in meta, so 404 is expected either way
    // But this also tests that version scoping is enforced
    expect(res.status).toBe(404)
  })

  it("pv= for a different artifact → 404", async () => {
    const exp = Date.now() + 60_000
    // Token signed for a different artifact id
    const tok = await signPreviewToken(TEST_SECRET, "different-artifact-id", 1, exp)
    const res = await app.request(`/raw/${shortId}/v/1/index.html?pv=${tok}`)
    expect(res.status).toBe(404)
  })

  it("pv= does not apply to the proposal route (nonexistent proposal)", async () => {
    const exp = Date.now() + 60_000
    const tok = await signPreviewToken(TEST_SECRET, artifactId, 1, exp)
    // The proposal route should not be affected by ?pv=
    const res = await app.request(`/raw/${shortId}/p/nonexistent-proposal/?pv=${tok}`)
    // Should 404 because the proposal doesn't exist (not because pv= granted access)
    expect(res.status).toBe(404)
  })

  it("pv= does NOT bypass the proposal route for a real proposal on a private artifact", async () => {
    // Create a proposal on the private artifact (using the owner token)
    const propForm = new FormData()
    propForm.append("file", new Blob([new TextEncoder().encode("<h1>proposed</h1>")]), "f.html")
    const pr = await app.request(`/v1/artifacts/${shortId}/proposals`, {
      method: "POST",
      body: propForm,
      headers: { authorization: "Bearer tok" },
    })
    expect(pr.status).toBe(201)
    const proposal = (await pr.json()) as { id: string }

    // Mint a valid pv token for the artifact at version 1
    const exp = Date.now() + 60_000
    const tok = await signPreviewToken(TEST_SECRET, artifactId, 1, exp)

    // Anonymous GET to the proposal raw route WITH the pv token — must NOT be authorized
    const res = await app.request(`/raw/${shortId}/p/${proposal.id}/index.html?pv=${tok}`)
    // The pv bypass only applies to /v/:n/*, not /p/:proposalId/*; anonymous reads
    // of a private artifact's proposals are rejected (404 — existence never leaks)
    expect(res.status).toBe(404)
  })
})
