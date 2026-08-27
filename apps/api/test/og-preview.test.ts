/**
 * Task 6: /v1/og/:ref serves the rendered PNG when preview_status === "ready",
 * falls back to the SVG card otherwise, and NEVER leaks the PNG for a private
 * artifact to an anonymous requester.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type BlobStore, INTERNAL_DELIVERY, type NewRenderJob } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import type { AppDeps } from "../src/context"
import { runExportTick } from "../src/exports"
import { OG_TOKEN_TTL_MS, signOgToken, verifyOgToken } from "../src/lib/og-token"
import { signPreviewToken, verifyPreviewToken } from "../src/lib/preview-token"

const dir = mkdtempSync(join(tmpdir(), "derive-og-preview-"))

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const TOKEN = "tok"
const AUTH = { authorization: `Bearer ${TOKEN}` }

/** A minimal valid 1x1 PNG (67 bytes). */
const TINY_PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a, // PNG signature
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52, // IHDR chunk length + type
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01, // 1x1
  0x08,
  0x02,
  0x00,
  0x00,
  0x00,
  0x90,
  0x77,
  0x53, // 8-bit RGB, crc
  0xde,
  0x00,
  0x00,
  0x00,
  0x0c,
  0x49,
  0x44,
  0x41, // IDAT chunk
  0x54,
  0x08,
  0xd7,
  0x63,
  0xf8,
  0xcf,
  0xc0,
  0x00,
  0x00,
  0x00,
  0x02,
  0x00,
  0x01,
  0xe2,
  0x21,
  0xbc,
  0x33,
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4e, // IEND chunk
  0x44,
  0xae,
  0x42,
  0x60,
  0x82,
])

const SECRET = "og-secret"

const makeApp = (name: string, extraDeps: Partial<AppDeps> = {}) => {
  const dbPath = join(dir, `${name}.db`)
  const meta = new SqliteMetaStore(dbPath)
  const blobs = new FsBlobStore(join(dir, `blobs-${name}`))
  const app = createApp({
    meta,
    blobs,
    baseUrl: "http://derive.test",
    token: TOKEN,
    encryptionKey: SECRET,
    ...extraDeps,
  })
  return { app, meta, blobs }
}

describe("durable export delivery", () => {
  it("does not duplicate email when completion fails after the outbox enqueue", async () => {
    const { app, meta, blobs } = makeApp("export-email-idempotency")
    const { short_id, current_version } = await publish(app, "<h1>Email fixture</h1>", {
      visibility: "public",
      title: "Pinned fixture",
    })
    const artifact = await meta.getByShortId(short_id)
    if (!artifact) throw new Error("artifact not found after publish")
    await meta.enqueueExportJob({
      id: "ej_email_retry",
      artifact_id: artifact.id,
      version_n: current_version,
      org_id: artifact.org_id,
      requested_by: "test-user",
      kind: "email",
      profile: "email-hero",
      renderer_scope: "http://derive.test",
      options_json: JSON.stringify({ recipient: "qa@example.test", title: "Pinned fixture" }),
      input_hash: "email-retry-input",
    })

    // The email image is stored first; fail the second write, which is the durable
    // export-result write after the stable-id outbox row has been enqueued.
    let puts = 0
    const flakyBlobs: BlobStore = {
      get: (key) => blobs.get(key),
      put: async (bytes) => {
        puts += 1
        if (puts === 2) throw new Error("simulated result-store outage")
        return blobs.put(bytes)
      },
    }
    const deps = {
      meta,
      blobs: flakyBlobs,
      renderer: { screenshot: async () => TINY_PNG },
      baseUrl: "http://derive.test",
      secret: SECRET,
    }
    expect(await runExportTick(deps)).toBe(1)
    expect((await meta.getExportJob("ej_email_retry"))?.status).toBe("failed")
    const [delivery] = await meta.recentDeliveries(INTERNAL_DELIVERY, 10)
    expect(delivery?.id).toBe("wd_export_ej_email_retry")
    expect(JSON.parse(delivery?.payload ?? "{}")).toMatchObject({
      to: "qa@example.test",
      attachments: [{ contentId: "derive-export" }],
    })

    // Model the sender winning before the export lease recovers. The retry must
    // observe the stable delivered row and finish without inserting another email.
    if (!delivery) throw new Error("email delivery was not enqueued")
    await meta.updateDelivery(delivery.id, {
      status: "delivered",
      attempts: 1,
      last_error: null,
      next_attempt_at: new Date().toISOString(),
    })
    await meta.updateExportJob("ej_email_retry", {
      status: "failed",
      next_attempt_at: new Date(0).toISOString(),
      updated_at: new Date().toISOString(),
    })
    expect(await runExportTick(deps)).toBe(1)
    expect((await meta.getExportJob("ej_email_retry"))?.status).toBe("ready")
    const deliveries = await meta.recentDeliveries(INTERNAL_DELIVERY, 10)
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]?.status).toBe("delivered")
  })

  it("bounds poison retries and skips cancelled or expired work", async () => {
    const { app, meta, blobs } = makeApp("export-failure-bounds")
    const { short_id, current_version } = await publish(app, "<h1>Failure fixture</h1>", {
      visibility: "public",
    })
    const artifact = await meta.getByShortId(short_id)
    if (!artifact) throw new Error("artifact not found after publish")
    const enqueue = (id: string, expiresAt: string | null = null) =>
      meta.enqueueExportJob({
        id,
        artifact_id: artifact.id,
        version_n: current_version,
        org_id: artifact.org_id,
        requested_by: "test-user",
        kind: "page_pdf",
        profile: "page-pdf",
        renderer_scope: "http://derive.test",
        options_json: "{}",
        input_hash: `${id}-input`,
        expires_at: expiresAt,
      })
    const deps = {
      meta,
      blobs,
      renderer: {
        screenshot: async () => TINY_PNG,
        pdf: async () => {
          throw new Error("renderer crashed at page 2")
        },
      },
      baseUrl: "http://derive.test",
      secret: SECRET,
    }

    await enqueue("ej_poison")
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(await runExportTick(deps, 1)).toBe(1)
      const job = await meta.getExportJob("ej_poison")
      expect(job?.attempts).toBe(attempt)
      expect(job?.status).toBe(attempt === 4 ? "dead" : "failed")
      if (attempt < 4)
        await meta.updateExportJob("ej_poison", {
          status: "failed",
          next_attempt_at: new Date(0).toISOString(),
          updated_at: new Date().toISOString(),
        })
    }
    expect((await meta.getExportJob("ej_poison"))?.last_error).toBe("renderer crashed at page 2")

    await enqueue("ej_cancelled")
    await meta.updateExportJob("ej_cancelled", {
      status: "cancelled",
      updated_at: new Date().toISOString(),
    })
    expect(await runExportTick(deps, 1)).toBe(0)
    expect((await meta.getExportJob("ej_cancelled"))?.attempts).toBe(0)

    await enqueue("ej_expired", new Date(0).toISOString())
    expect(await runExportTick(deps, 1)).toBe(1)
    expect((await meta.getExportJob("ej_expired"))?.status).toBe("expired")
    expect(await meta.recentDeliveries(INTERNAL_DELIVERY, 10)).toHaveLength(0)
  })
})

/** Upload an artifact via the API and return its short_id + current_version. */
const publish = async (
  app: ReturnType<typeof createApp>,
  content: string,
  fields: Record<string, string> = {},
) => {
  const form = new FormData()
  form.append("file", new Blob([new TextEncoder().encode(content)]), "f.html")
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  const res = await app.request("/v1/artifacts", { method: "POST", body: form, headers: AUTH })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { short_id: string; current_version: number }
  return body
}

describe("/v1/og/:ref — PNG preview serving", () => {
  it("returns PNG bytes when preview_status is ready", async () => {
    const { app, meta, blobs } = makeApp("og-with-preview")
    const { short_id, current_version } = await publish(app, "<h1>Ready</h1>", {
      visibility: "public",
      title: "Preview Ready",
    })

    // Resolve the internal artifact id (not returned by the publish API).
    const artifact = await meta.getByShortId(short_id)
    if (!artifact) throw new Error("artifact not found after publish")

    // Store a PNG in the blob store and mark the version preview as ready.
    const pngKey = await blobs.put(TINY_PNG)
    await meta.setVersionPreview(artifact.id, current_version, {
      preview_key: pngKey,
      preview_status: "ready",
    })

    const res = await app.request(`/v1/og/${short_id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    // A public artifact's screenshot may live in shared caches.
    expect(res.headers.get("cache-control")).toContain("public")

    // Body must be the exact PNG bytes we stored.
    const buf = await res.arrayBuffer()
    expect(new Uint8Array(buf)).toEqual(TINY_PNG)
  })

  it("gated artifact's PNG (served to an authorized reader) is never shared-cacheable", async () => {
    const { app, meta, blobs } = makeApp("og-gated-cache")
    const { short_id, current_version } = await publish(app, "<h1>Team only</h1>", {
      visibility: "org",
      title: "Gated Artifact",
    })

    const artifact = await meta.getByShortId(short_id)
    if (!artifact) throw new Error("artifact not found after publish")
    const pngKey = await blobs.put(TINY_PNG)
    await meta.setVersionPreview(artifact.id, current_version, {
      preview_key: pngKey,
      preview_status: "ready",
    })

    // The token principal reads as owner, so the PNG branch is reached — but the
    // response must be browser-cache only (private), never shared-cacheable.
    const res = await app.request(`/v1/og/${short_id}`, { headers: AUTH })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("cache-control")).toContain("private")
    expect(res.headers.get("cache-control")).not.toContain("public")
  })

  it("gated artifact's SVG card, oembed and embed are not shared-cacheable either", async () => {
    const { app } = makeApp("og-gated-siblings")
    const { short_id } = await publish(app, "<h1>Team only</h1>", {
      visibility: "org",
      title: "Gated Artifact",
    })
    // No stored preview, so /v1/og falls to the SVG branch. All three of these are built
    // from `infoFor` — the artifact's own title, counts and DATA SLOTS — and are assembled
    // at all only for a caller who could read it. The PNG sibling above has always been
    // private; these three shipped `public` while carrying the same revealed content, so a
    // CDN or corporate proxy could serve an authorized member's card, figures and all, to
    // someone with no access. Nothing varies on the credential, so `private` is the fix.
    const url = encodeURIComponent(`http://derive.test/artifacts/${short_id}`)
    for (const path of [`/v1/og/${short_id}`, `/v1/oembed?url=${url}`, `/v1/embed/${short_id}`]) {
      const res = await app.request(path, { headers: AUTH })
      expect(res.status, path).toBe(200)
      expect(res.headers.get("cache-control"), path).toContain("private")
      expect(res.headers.get("cache-control"), path).not.toContain("public")
    }
    // The ANONYMOUS card is the title-less locked one, with nothing in it worth protecting,
    // so it keeps caching hard at the edge — the reason unfurls stay fast.
    const anon = await app.request(`/v1/og/${short_id}`)
    expect(anon.headers.get("cache-control")).toContain("public")
  })

  it("SECURITY: private artifact with ready preview → anonymous caller gets SVG, never the PNG", async () => {
    const { app, meta, blobs } = makeApp("og-private-anon")
    // Upload as the static token (owner), then the anonymous caller has no token.
    const { short_id, current_version } = await publish(app, "<h1>Secret</h1>", {
      visibility: "org",
      title: "Private Artifact",
    })

    // Resolve the internal artifact id (not returned by the publish API).
    const artifact = await meta.getByShortId(short_id)
    if (!artifact) throw new Error("artifact not found after publish")

    // Mark preview as ready with a real PNG in the blob store.
    const pngKey = await blobs.put(TINY_PNG)
    await meta.setVersionPreview(artifact.id, current_version, {
      preview_key: pngKey,
      preview_status: "ready",
    })

    // Anonymous request (no Authorization header) — same app instance, same stores.
    const anonApp = createApp({
      meta,
      blobs,
      baseUrl: "http://derive.test",
      token: TOKEN,
    })
    const res = await anonApp.request(`/v1/og/${short_id}`) // no auth header
    expect(res.status).toBe(200)
    // Must still be SVG — the locked card, not the PNG.
    expect(res.headers.get("content-type")).toContain("image/svg+xml")
    const body = await res.text()
    expect(body).toContain("<svg")
    expect(body).not.toContain("Private Artifact")
  })
})

// A SIGNED URL FOR ONE IMAGE (lib/og-token.ts).
//
// Slack fetches an unfurl's preview image ANONYMOUSLY, so a workspace-listed doc — the shape
// people paste most — could only ever show the title-less padlock. A token minted for exactly
// one artifact+version buys that image without loosening this endpoint for anyone else.
//
// Every test here is really the same question asked from a different angle: what ELSE does
// holding this URL get you? The answer has to stay "nothing".

describe("/v1/og/:ref — the signed preview token", () => {
  /** A workspace-visible artifact with a rendered preview, plus its ids. */
  const withPreview = async (name: string, visibility = "org") => {
    const { app, meta, blobs } = makeApp(name)
    const { short_id, current_version } = await publish(app, "<h1>Team</h1>", {
      visibility,
      title: "Team Doc",
    })
    const artifact = await meta.getByShortId(short_id)
    if (!artifact) throw new Error("artifact not found after publish")
    const pngKey = await blobs.put(TINY_PNG)
    await meta.setVersionPreview(artifact.id, current_version, {
      preview_key: pngKey,
      preview_status: "ready",
    })
    return { app, meta, blobs, artifact, short_id, current_version }
  }

  const tokenFor = (artifactId: string, n: number, ttlMs = OG_TOKEN_TTL_MS) =>
    signOgToken(SECRET, artifactId, n, Date.now() + ttlMs)

  it("serves the PNG to an anonymous fetch that carries a valid token", async () => {
    const { app, artifact, short_id, current_version } = await withPreview("og-tok-ok")
    // No credential at all — exactly what Slack's image proxy sends.
    const res = await app.request(
      `/v1/og/${short_id}?t=${await tokenFor(artifact.id, current_version)}`,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(TINY_PNG)
    // Shared-cacheable BECAUSE the credential is in the URL: a cache keyed on the full URL can
    // only return these bytes to someone who already presented the token. Slack's proxy
    // caching this is the point.
    expect(res.headers.get("cache-control")).toContain("public")
  })

  it("without the token, the same fetch still gets the locked card", async () => {
    const { app, short_id } = await withPreview("og-tok-absent")
    const res = await app.request(`/v1/og/${short_id}`)
    expect(res.headers.get("content-type")).toContain("image/svg+xml")
    expect(await res.text()).not.toContain("Team Doc")
  })

  it("a token for one artifact cannot be spent on another", async () => {
    // The check that keeps this from becoming a skeleton key: a doc I may read mints a token,
    // and without binding it to `:ref` that token would fetch any other doc's screenshot.
    const { app, meta, blobs, artifact, current_version } = await withPreview("og-tok-swap")
    const other = await publish(app, "<h1>Other</h1>", { visibility: "org", title: "Other Doc" })
    const otherRec = await meta.getByShortId(other.short_id)
    if (!otherRec) throw new Error("other artifact not found")
    // The other doc must have a preview of its OWN and be otherwise servable — else this
    // passes for want of a render rather than because the binding held.
    await meta.setVersionPreview(otherRec.id, other.current_version, {
      preview_key: await blobs.put(TINY_PNG),
      preview_status: "ready",
    })
    const res = await app.request(
      `/v1/og/${other.short_id}?t=${await tokenFor(artifact.id, current_version)}`,
    )
    expect(res.headers.get("content-type")).toContain("image/svg+xml")
  })

  it("retires itself on the next publish, rather than following the document", async () => {
    // The version pin is what bounds a leak: whatever escapes shows the doc as it WAS, and
    // stops being current the moment somebody edits.
    const { app, meta, blobs, artifact, short_id, current_version } =
      await withPreview("og-tok-stale")
    const stale = await tokenFor(artifact.id, current_version)
    expect((await app.request(`/v1/og/${short_id}?t=${stale}`)).headers.get("content-type")).toBe(
      "image/png",
    )
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("<h1>v2</h1>")]), "f.html")
    const bumped = await app.request(`/v1/artifacts/${short_id}/versions`, {
      method: "POST",
      body: form,
      headers: AUTH,
    })
    expect(bumped.status).toBeLessThan(300)
    const v2 = (await meta.getByShortId(short_id))?.current_version
    expect(v2).toBe(current_version + 1)
    // v2 renders too — so the ONLY thing between the old token and a current screenshot is
    // the pin. Without it this test would pass merely because v2 had no preview yet.
    await meta.setVersionPreview(artifact.id, v2 as number, {
      preview_key: await blobs.put(TINY_PNG),
      preview_status: "ready",
    })
    const after = await app.request(`/v1/og/${short_id}?t=${stale}`)
    expect(after.headers.get("content-type")).toContain("image/svg+xml")
    // ...and a token minted for v2 works, so the pin is a pin and not a wall.
    const fresh = await tokenFor(artifact.id, v2 as number)
    expect((await app.request(`/v1/og/${short_id}?t=${fresh}`)).headers.get("content-type")).toBe(
      "image/png",
    )
  })

  it("expires, and expiry DEGRADES to the card rather than breaking the image", async () => {
    // Why a long TTL is affordable: a Slack message keeps its unfurl for ever and Slack
    // re-fetches on its own schedule, so every expiry eventually lands on a live message. The
    // worst it may do is put back the card that predates this feature — never a 4xx, never a
    // broken-image icon.
    const { app, artifact, short_id, current_version } = await withPreview("og-tok-exp")
    const expired = await tokenFor(artifact.id, current_version, -1000)
    const res = await app.request(`/v1/og/${short_id}?t=${expired}`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("image/svg+xml")
  })

  it("rejects a forged token, and one signed with a different secret", async () => {
    const { app, artifact, short_id, current_version } = await withPreview("og-tok-forged")
    const wrongKey = await signOgToken(
      "not-the-secret",
      artifact.id,
      current_version,
      Date.now() + OG_TOKEN_TTL_MS,
    )
    for (const t of ["garbage", "a.b", wrongKey]) {
      const res = await app.request(`/v1/og/${short_id}?t=${encodeURIComponent(t)}`)
      expect(res.status, t).toBe(200)
      expect(res.headers.get("content-type"), t).toContain("image/svg+xml")
    }
  })

  it("cannot be replayed as a renderer preview token — different domain, same shape", async () => {
    // The two kinds carry an identical `<artifactId>.<n>` payload, and the renderer's grants
    // RAW CONTENT. Only the domain string separates them, which is the whole reason
    // capability-token.ts has one.
    const { artifact, current_version } = await withPreview("og-tok-domain")
    const og = await tokenFor(artifact.id, current_version)
    expect(await verifyPreviewToken(SECRET, og, Date.now())).toBeNull()
    const pv = await signPreviewToken(SECRET, artifact.id, current_version, Date.now() + 60_000)
    expect(await verifyOgToken(SECRET, pv, Date.now())).toBeNull()
  })

  it("buys the image and NOT the metadata: no title leaks when the render is missing", async () => {
    // The subtle one. A valid token whose PNG is not ready must land on the GENERIC card, not
    // the revealed one — otherwise the grant silently widens into a metadata read for exactly
    // as long as a render is pending or failed.
    const { app, meta } = makeApp("og-tok-nopng")
    const { short_id, current_version } = await publish(app, "<h1>Team</h1>", {
      visibility: "org",
      title: "Unrendered Secret",
    })
    const artifact = await meta.getByShortId(short_id)
    if (!artifact) throw new Error("artifact not found after publish")
    const res = await app.request(
      `/v1/og/${short_id}?t=${await signOgToken(SECRET, artifact.id, current_version, Date.now() + OG_TOKEN_TTL_MS)}`,
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("<svg")
    expect(body).not.toContain("Unrendered Secret")
  })
})

// THE HEADER WITHOUT WHICH NONE OF THIS RENDERS.
//
// Slack's implementation guide: "For security reasons, these public URLs must include the CORS
// response header set to access-control-allow-origin:https://app.slack.com."
//
// Worth stating what that implies, because it is not in the docs and it changes the threat
// model: CORS is a BROWSER mechanism, so the Slack client loads the preview from the viewer's
// own browser rather than proxying it server-side. The token in the URL is spent by the reader.

describe("/v1/og/:ref — the header Slack requires on a preview image", () => {
  it("is on the PNG a card actually displays", async () => {
    const { app, meta, blobs } = makeApp("og-cors-png")
    const { short_id, current_version } = await publish(app, "<h1>Hi</h1>", {
      visibility: "public",
      title: "Corsy",
    })
    const artifact = await meta.getByShortId(short_id)
    if (!artifact) throw new Error("artifact not found after publish")
    await meta.setVersionPreview(artifact.id, current_version, {
      preview_key: await blobs.put(TINY_PNG),
      preview_status: "ready",
    })
    const res = await app.request(`/v1/og/${short_id}`)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.slack.com")
  })
})

// ---------------------------------------------------------------------------
// The trigger side of previews: publishing enqueues a render job (for the internal
// artifact id) only when renderPreviews is on. Spies on meta.enqueueRenderJob, the only
// storage sink enqueueRender uses, so no renderer is needed.
describe("the preview render trigger — gated by renderPreviews", () => {
  /**
   * Task 5: preview trigger — enqueue a render job on version.published,
   * gated by renderPreviews.
   *
   * We spy on meta.enqueueRenderJob directly (the only storage sink
   * enqueueRender uses), so the test is self-contained — no renderer needed.
   */

  const dir = mkdtempSync(join(tmpdir(), "derive-preview-trigger-"))

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const TOKEN = "tok"
  const TOKEN_HEADER = { authorization: `Bearer ${TOKEN}` }
  const HUMAN = {
    id: "u_preview_owner",
    createdAt: "2020-01-01T00:00:00.000Z",
    email: "owner@derive.test",
    name: "Owner",
  }

  /** Build an app + a spy counter, optionally with renderPreviews on/off. */
  const makeApp = (name: string, renderPreviews: boolean) => {
    const dbPath = join(dir, `${name}.db`)
    const meta = new SqliteMetaStore(dbPath)

    const enqueuedJobs: NewRenderJob[] = []
    const pokeCalls: number[] = []

    // Wrap meta so we can spy on enqueueRenderJob
    const spyMeta = new Proxy(meta, {
      get(target, prop, receiver) {
        if (prop === "enqueueRenderJob") {
          return async (job: NewRenderJob) => {
            enqueuedJobs.push(job)
            return target.enqueueRenderJob(job)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })

    const extraDeps: Partial<AppDeps> = renderPreviews
      ? {
          renderPreviews: true,
          pokePreviews: () => {
            pokeCalls.push(Date.now())
          },
        }
      : {}

    const app = createApp({
      meta: spyMeta,
      blobs: new FsBlobStore(join(dir, `blobs-${name}`)),
      baseUrl: "http://derive.test",
      token: TOKEN,
      defaultOrgId: "default",
      auth: {
        handler: async () => new Response(null, { status: 404 }),
        api: {
          getSession: async ({ headers }: { headers: Headers }) =>
            headers.get("x-test-user") === HUMAN.email ? { user: HUMAN } : null,
        },
      } as unknown as AppDeps["auth"],
      ...extraDeps,
    })

    return { app, meta, enqueuedJobs, pokeCalls }
  }

  /** Publish a new artifact and return the response + parsed JSON. */
  const publishArtifact = async (app: ReturnType<typeof createApp>, content = "<h1>hi</h1>") => {
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode(content)]), "f.html")
    const res = await app.request("/v1/artifacts", {
      method: "POST",
      body: form,
      headers: TOKEN_HEADER,
    })
    return res
  }

  it("enqueues ONE render job when renderPreviews is true", async () => {
    const { app, enqueuedJobs } = makeApp("trigger-on", true)

    const res = await publishArtifact(app)
    expect(res.status).toBe(201)
    const body = (await res.json()) as { short_id: string; current_version: number }

    // Give the fire-and-forget promise a tick to settle
    await new Promise((r) => setTimeout(r, 20))

    expect(enqueuedJobs).toHaveLength(1)
    // artifact_id is the internal UUID (not short_id); just verify it's a string
    const job0 = enqueuedJobs[0]
    if (!job0) throw new Error("expected enqueuedJobs[0]")
    expect(typeof job0.artifact_id).toBe("string")
    expect(job0.artifact_id).toMatch(/^a_/)
    expect(job0.version_n).toBe(body.current_version)
  })

  it("does NOT enqueue any render jobs when renderPreviews is false/omitted", async () => {
    const { app, enqueuedJobs } = makeApp("trigger-off", false)

    const res = await publishArtifact(app)
    expect(res.status).toBe(201)

    await new Promise((r) => setTimeout(r, 20))

    expect(enqueuedJobs).toHaveLength(0)
  })
})
