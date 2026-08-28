import type {
  ArtifactRecord,
  BlobStore,
  MetaStore,
  NewArtifact,
  NewRenderJob,
  PreviewStatus,
  RenderJobRecord,
  RenderJobStatus,
  VersionRecord,
} from "@derive/core"
import { sha256Hex } from "@derive/core"
import { unzipSync } from "fflate"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  DECK_LAST_SLIDE_ATTRIBUTE,
  DECK_PRINT_CSS,
  markFinalDeckSlideForPrint,
  prepareDeckPrint,
} from "../src/lib/deck-print"
import { buildRichExportEmail, parseEmailLayout } from "../src/lib/email-layout"
import {
  buildExportEmail,
  buildQaEmailCapture,
  csvFromJson,
  exportInputHash,
  imageBackedPptx,
  normalizeExportOptions,
} from "../src/lib/export-system"
import { exportOnlyAlarmDecision, previewRendererWorkMode } from "../src/preview-do"
import {
  assertNavigationOk,
  assertRenderedDocumentOk,
  enqueueRender,
  MAX_ATTEMPTS,
  runRenderTick,
  startPreviewWorker,
  sweepMissingRenders,
} from "../src/previews"

describe("export contracts", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("marks the actual final deck slide even when deck chrome follows it", async () => {
    const attrs = [new Set<string>(), new Set<string>(), new Set<string>()]
    const nodes = attrs.map((attributes) => ({
      removeAttribute: (name: string) => attributes.delete(name),
      setAttribute: (name: string) => attributes.add(name),
    }))
    const chrome = { role: "counter" }
    vi.stubGlobal("document", {
      querySelectorAll: () => nodes,
      body: { children: [...nodes, chrome] },
    })

    expect(
      markFinalDeckSlideForPrint({
        selector: "[data-derive-slide], .slide",
        attribute: DECK_LAST_SLIDE_ATTRIBUTE,
      }),
    ).toBe(3)
    expect(attrs.map((attributes) => attributes.has(DECK_LAST_SLIDE_ATTRIBUTE))).toEqual([
      false,
      false,
      true,
    ])
    expect(DECK_PRINT_CSS).toContain(
      `[${DECK_LAST_SLIDE_ATTRIBUTE}]{page-break-after:auto!important;break-after:auto!important}`,
    )

    let installedCss = ""
    expect(
      await prepareDeckPrint(
        async (callback, input) => callback(input),
        async (css) => {
          installedCss = css
        },
      ),
    ).toBe(3)
    expect(installedCss).toBe(DECK_PRINT_CSS)
  })

  it("makes export-only renderer isolation explicit and fail-closed on the exact flag", () => {
    expect(previewRendererWorkMode({ DERIVE_EXPORTS_ONLY: "true" })).toBe("exports-only")
    expect(previewRendererWorkMode({ DERIVE_EXPORTS_ONLY: "false" })).toBe("full")
    expect(previewRendererWorkMode({})).toBe("full")
  })

  it("gives export-only previews one bounded delayed retry probe, then goes idle", () => {
    expect(exportOnlyAlarmDecision(1, false)).toEqual({ delayMs: 1_500, idleProbeArmed: false })
    expect(exportOnlyAlarmDecision(0, false)).toEqual({ delayMs: 60_000, idleProbeArmed: true })
    expect(exportOnlyAlarmDecision(0, true)).toEqual({ delayMs: null, idleProbeArmed: false })
  })
  it("normalizes bounded view state before hashing an immutable request", async () => {
    const options = normalizeExportOptions({ region: "  #chart  ", note: ` ${"x".repeat(3_000)} ` })
    expect(options.region).toBe("#chart")
    expect(options.note).toHaveLength(2_000)
    const a = await exportInputHash({
      artifactId: "a1",
      version: 2,
      requestedBy: "u1",
      rendererScope: "https://preview.test",
      kind: "chart_png",
      options: { region: " #chart " },
    })
    const b = await exportInputHash({
      artifactId: "a1",
      version: 2,
      requestedBy: "u1",
      rendererScope: "https://preview.test",
      kind: "chart_png",
      options: { region: "#chart" },
    })
    expect(a).toBe(b)
    expect(
      await exportInputHash({
        artifactId: "a1",
        version: 2,
        requestedBy: "u1",
        rendererScope: "https://other-preview.test",
        kind: "chart_png",
        options: { region: "#chart" },
      }),
    ).not.toBe(a)
  })

  it("exports only declared tabular JSON to CSV", () => {
    expect(
      csvFromJson([
        { label: "A, B", value: 4 },
        { label: "C", value: 7 },
      ]),
    ).toBe('label,value\r\n"A, B",4\r\nC,7')
    expect(() => csvFromJson([1, 2, 3])).toThrow(/declared tabular fact/)
  })

  it("builds script-free, images-off-readable email and a complete image-backed PPTX", () => {
    const email = buildExportEmail({
      to: "qa@example.test",
      title: "Revenue <script>alert(1)</script>",
      note: "Pinned chart",
      openUrl: "https://derive.test/artifacts/a",
      imageUrl: "cid:derive-export",
      alt: "Revenue by month",
      version: 3,
    })
    expect(email.html).not.toContain("<script>")
    expect(email.html).toContain('src="cid:derive-export"')
    expect(email.html).toContain('alt="Revenue by month"')
    expect(email.text).toContain("Open: https://derive.test/artifacts/a")
    const capture = new TextDecoder().decode(
      buildQaEmailCapture({
        message: email,
        cidImage: new Uint8Array([1, 2, 3]),
        attachments: [{ filename: "derive-export.png", contentType: "image/png" }],
      }),
    )
    expect(capture).toContain("QA capture · no email was sent")
    expect(capture).toContain("data:image/png;base64,AQID")
    expect(capture).toContain("Plain-text alternative")
    expect(capture).not.toContain("cid:derive-export")

    const pptx = unzipSync(
      imageBackedPptx([new Uint8Array([1, 2]), new Uint8Array([3, 4])], "artifact v3"),
    )
    expect(Object.keys(pptx)).toEqual(
      expect.arrayContaining([
        "ppt/slides/slide1.xml",
        "ppt/slides/slide2.xml",
        "ppt/media/image1.png",
        "ppt/media/image2.png",
      ]),
    )
    expect(new TextDecoder().decode(pptx["docProps/core.xml"])).toContain("artifact v3")
  })

  it("renders declared KPIs and charts as escaped, image-independent email HTML", () => {
    const layout = parseEmailLayout({
      schema: "derive.email/v1",
      preheader: "Executive pulse",
      title: "Revenue & pipeline",
      subtitle: "Actual email HTML — no canvas or JavaScript",
      blocks: [
        {
          type: "kpis",
          items: [
            { label: "ARR", value: "$12.4M", delta: "+18% YoY" },
            { label: "Coverage", value: "3.2×" },
          ],
        },
        {
          type: "bars",
          title: "Pipeline by segment",
          items: [
            { label: "Enterprise <script>", value: 72, display: "$7.2M" },
            { label: "Mid-market", value: -14, display: "−$1.4M" },
          ],
        },
      ],
    })
    expect(layout).not.toBeNull()
    if (!layout) throw new Error("expected a parsed email layout")
    const email = buildRichExportEmail({
      to: "qa@example.test",
      subjectTitle: "Quarterly pulse",
      openUrl: "https://derive.test/artifacts/pulse/v/4",
      version: 4,
      layout,
    })
    expect(email.html).toContain("$12.4M")
    expect(email.html).toContain("width:100%")
    expect(email.html).toContain("−$1.4M")
    expect(email.html).toContain("Enterprise &lt;script&gt;")
    expect(email.html).not.toContain("<script>")
    expect(email.html).not.toContain("<canvas")
    expect(email.html).not.toContain("<img")
    expect(email.text).toContain("Pipeline by segment")
  })

  it("rejects malformed declared layouts instead of silently changing representation", () => {
    expect(() =>
      parseEmailLayout({
        schema: "derive.email/v1",
        title: "Bad layout",
        blocks: [{ type: "button", label: "Unsafe", url: "javascript:alert(1)" }],
      }),
    ).toThrow(/must use https/)
    expect(parseEmailLayout({ schema: "some-other-contract" })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Fake BlobStore (content-addressed, Map-backed)
// ---------------------------------------------------------------------------
const makeBlobs = (): BlobStore => {
  const map = new Map<string, Uint8Array>()
  return {
    put: async (d) => {
      const k = await sha256Hex(d)
      map.set(k, d)
      return k
    },
    get: async (k) => map.get(k) ?? null,
  }
}

// ---------------------------------------------------------------------------
// Fake MetaStore (map-backed: artifacts + versions + render_jobs)
// ---------------------------------------------------------------------------

type FakeArtifact = NewArtifact & {
  current_version: number
  created_at: string
  removed_at: null
  locked: 0 | 1
  current_content_type: string | null
  updated_at: string | null
  source_path: string | null
  author_name: string | null
  author_login: string | null
  author_avatar: string | null
  author_gh_id: string | null
  author_id: string | null
  password_hash: string | null
}

type FakeVersion = {
  id: string
  artifact_id: string
  n: number
  blob_key: string
  content_type: string
  size_bytes: number
  author: string
  author_login: string | null
  author_avatar: string | null
  author_gh_id: string | null
  author_id: string | null
  message: string | null
  name: string | null
  preview_key: string | null
  preview_status: PreviewStatus | null
  preview_error: string | null
  preview_full_key: string | null
  preview_full_status: PreviewStatus | null
  preview_full_error: string | null
  preview_marked_key: string | null
  preview_marked_status: PreviewStatus | null
  preview_marked_error: string | null
  created_at: string
}

type FakeJob = RenderJobRecord

interface FakeMeta {
  meta: MetaStore
  artifacts: Map<string, FakeArtifact>
  versions: Map<string, FakeVersion> // keyed "artifactId:n"
  jobs: Map<string, FakeJob>
}

const makeFakes = (opts?: {
  // Test hook: makes setVersionPreviewVariant throw when this predicate matches, to
  // simulate a metastore write failure — used to reproduce and pin the "the FAILURE-
  // recording write itself throws" case (regression: it used to escape and corrupt
  // an unrelated, already-successful render's status).
  failVariantWrite?: (
    variant: "full" | "marked",
    status: PreviewStatus | null | undefined,
  ) => boolean
  // Test hook: makes updateRenderJob throw when this predicate matches, to simulate a
  // metastore write failure on the job-completion write itself.
  failUpdateRenderJob?: (fields: { status: RenderJobStatus }) => boolean
}): FakeMeta => {
  const artifacts = new Map<string, FakeArtifact>()
  const versions = new Map<string, FakeVersion>()
  const jobs = new Map<string, FakeJob>()

  const meta = {
    // artifact helpers
    createArtifact: async (a: NewArtifact): Promise<FakeArtifact> => {
      const rec: FakeArtifact = {
        ...a,
        current_version: 0,
        created_at: new Date().toISOString(),
        removed_at: null,
        locked: 0,
        current_content_type: null,
        updated_at: null,
        source_path: null,
        author_name: null,
        author_login: null,
        author_avatar: null,
        author_gh_id: null,
        author_id: null,
        password_hash: null,
      }
      artifacts.set(a.id, rec)
      return rec
    },
    getArtifactById: async (id: string): Promise<ArtifactRecord | null> =>
      (artifacts.get(id) as ArtifactRecord) ?? null,

    // version helpers
    getVersion: async (artifactId: string, n: number): Promise<VersionRecord | null> =>
      (versions.get(`${artifactId}:${n}`) as VersionRecord) ?? null,
    setVersionPreview: async (
      artifactId: string,
      n: number,
      fields: {
        preview_key?: string | null
        preview_status?: PreviewStatus | null
        preview_error?: string | null
      },
    ): Promise<void> => {
      const key = `${artifactId}:${n}`
      const v = versions.get(key)
      if (!v) return
      if ("preview_key" in fields) v.preview_key = fields.preview_key ?? null
      if ("preview_status" in fields) v.preview_status = fields.preview_status ?? null
      if ("preview_error" in fields) v.preview_error = fields.preview_error ?? null
    },
    setVersionPreviewVariant: async (
      artifactId: string,
      n: number,
      variant: "full" | "marked",
      fields: { key?: string | null; status?: PreviewStatus | null; error?: string | null },
    ): Promise<void> => {
      if (opts?.failVariantWrite?.(variant, fields.status))
        throw new Error(`simulated metastore failure writing ${variant} status=${fields.status}`)
      const v = versions.get(`${artifactId}:${n}`)
      if (!v) return
      if (variant === "full") {
        if ("key" in fields) v.preview_full_key = fields.key ?? null
        if ("status" in fields) v.preview_full_status = fields.status ?? null
        if ("error" in fields) v.preview_full_error = fields.error ?? null
      } else {
        if ("key" in fields) v.preview_marked_key = fields.key ?? null
        if ("status" in fields) v.preview_marked_status = fields.status ?? null
        if ("error" in fields) v.preview_marked_error = fields.error ?? null
      }
    },

    // render job helpers
    enqueueRenderJob: async (j: NewRenderJob): Promise<void> => {
      const rec: FakeJob = {
        ...j,
        status: "pending",
        attempts: 0,
        last_error: null,
        next_attempt_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      }
      jobs.set(j.id, rec)
    },
    versionsMissingPreview: async (
      limit: number,
    ): Promise<Array<{ artifact_id: string; n: number }>> => {
      const out: Array<{ artifact_id: string; n: number }> = []
      for (const a of artifacts.values()) {
        if (out.length >= limit) break
        if (a.removed_at !== null) continue
        const v = versions.get(`${a.id}:${a.current_version}`)
        if (!v || v.preview_status !== null) continue
        const pending = [...jobs.values()].some(
          (j) => j.artifact_id === a.id && j.status === "pending",
        )
        if (!pending) out.push({ artifact_id: a.id, n: a.current_version })
      }
      return out
    },
    claimDueRenderJobs: async (
      _now: string,
      limit: number,
      leaseUntil: string,
    ): Promise<RenderJobRecord[]> => {
      const claimed: FakeJob[] = []
      for (const job of jobs.values()) {
        if (claimed.length >= limit) break
        if (job.status !== "pending") continue
        if (new Date(job.next_attempt_at) > new Date(_now)) continue
        job.attempts += 1
        job.next_attempt_at = leaseUntil
        claimed.push(job)
      }
      return claimed
    },
    updateRenderJob: async (
      id: string,
      fields: {
        status: RenderJobStatus
        attempts: number
        last_error: string | null
        next_attempt_at: string
      },
    ): Promise<void> => {
      if (opts?.failUpdateRenderJob?.(fields))
        throw new Error(`simulated metastore failure writing job status=${fields.status}`)
      const job = jobs.get(id)
      if (!job) return
      job.status = fields.status
      job.attempts = fields.attempts
      job.last_error = fields.last_error
      job.next_attempt_at = fields.next_attempt_at
    },
  } as unknown as MetaStore

  return { meta, artifacts, versions, jobs }
}

// Helper: create an artifact + version in the fake store
const seedArtifact = async (
  fakes: FakeMeta,
  opts: {
    id: string
    shortId: string
    versionN: number
    currentVersion?: number
  },
): Promise<void> => {
  const { id, shortId, versionN } = opts
  const currentVersion = opts.currentVersion ?? versionN
  const art: FakeArtifact = {
    id,
    short_id: shortId,
    org_id: "org1",
    slug: null,
    title: "Test Art",
    workspace_access: "member",
    link_role: "viewer",
    listed: "public",
    kind: "file",
    spa: 0,
    current_version: currentVersion,
    created_at: new Date().toISOString(),
    removed_at: null,
    locked: 0,
    current_content_type: "text/html",
    updated_at: null,
    source_path: null,
    author_name: null,
    author_login: null,
    author_avatar: null,
    author_gh_id: null,
    author_id: null,
    password_hash: null,
  }
  fakes.artifacts.set(id, art)

  const ver: FakeVersion = {
    id: `v_${id}_${versionN}`,
    artifact_id: id,
    n: versionN,
    blob_key: "some-blob-key",
    content_type: "text/html",
    size_bytes: 100,
    author: "tester",
    author_login: null,
    author_avatar: null,
    author_gh_id: null,
    author_id: null,
    message: null,
    name: null,
    preview_key: null,
    preview_status: null,
    preview_error: null,
    preview_full_key: null,
    preview_full_status: null,
    preview_full_error: null,
    preview_marked_key: null,
    preview_marked_status: null,
    preview_marked_error: null,
    created_at: new Date().toISOString(),
  }
  fakes.versions.set(`${id}:${versionN}`, ver)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("previews: refusing to screenshot an error page", () => {
  // A browser pointed at a 404 renders the 404, and the screenshot SUCCEEDS. Without this
  // guard the job stored a picture of the words "not found" and marked itself ready: the
  // card permanently wrong, nothing retrying (nothing failed), the dead-render self-heal
  // never firing (a render exists), and republishing the only cure. Seen twice in one
  // afternoon on two different artifacts, 4.5KB where a real render is 70-110KB.
  it("throws on an error status, so the job fails and retries instead of storing the 404", () => {
    const url = "https://x.test/raw/ab12cd34/v/7/pv/SIGNED.TOKEN/index.html"
    expect(() => assertNavigationOk({ status: () => 404 }, url)).toThrow(/HTTP 404/)
    expect(() => assertNavigationOk({ status: () => 500 }, url)).toThrow(/HTTP 500/)
    // The shapes that are NOT errors: a real page, a redirect already followed, and a
    // same-document navigation that legitimately yields no response at all.
    expect(() => assertNavigationOk({ status: () => 200 }, url)).not.toThrow()
    expect(() => assertNavigationOk({ status: () => 304 }, url)).not.toThrow()
    expect(() => assertNavigationOk(null, url)).not.toThrow()
  })

  it("redacts the preview capability token out of the message it logs and stores", () => {
    // The URL carries a short-lived pv token that authorizes reading a PRIVATE artifact,
    // and this message lands in both the log and a stored DB column. Naming the failure
    // must not become how the credential escapes.
    let msg = ""
    try {
      assertNavigationOk(
        { status: () => 404 },
        "https://x.test/raw/ab12cd34/v/7/pv/eyJhbGciOi.SECRETSIG/index.html",
      )
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e)
    }
    expect(msg).toContain("HTTP 404")
    expect(msg).toContain("/pv/<redacted>/")
    expect(msg).not.toContain("SECRETSIG")
    expect(msg).not.toContain("eyJhbGciOi")
    // Still names WHICH artifact and version, which is the part that makes it diagnosable.
    expect(msg).toContain("ab12cd34")
    expect(msg).toContain("/v/7/")
  })

  it("rejects the raw route's service-error document when navigation has no status", () => {
    const url = "https://x.test/raw/ab12cd34/v/7/pv/eyJhbGciOi.SECRETSIG/index.html"
    expect(() =>
      assertRenderedDocumentOk(
        { contentType: "text/plain; charset=UTF-8", bodyText: "not found" },
        url,
      ),
    ).toThrow(/navigation rendered a not found service response/)
    expect(() =>
      assertRenderedDocumentOk({ contentType: "text/plain", bodyText: "  BLOB MISSING\n" }, url),
    ).toThrow(/navigation rendered a blob missing service response/)
  })
})

describe("previews: enqueueRender + runRenderTick", () => {
  it("Test A: renders a queued job → stores PNG → marks version ready + job done", async () => {
    const fakes = makeFakes()
    await seedArtifact(fakes, { id: "a1", shortId: "short1", versionN: 1 })

    const seen: string[] = []
    const renderer = {
      screenshot: async (url: string) => {
        seen.push(url)
        return new Uint8Array([1, 2, 3])
      },
    }

    await enqueueRender(fakes.meta, "a1", 1)
    expect(fakes.jobs.size).toBe(1)

    const n = await runRenderTick({
      meta: fakes.meta,
      blobs: makeBlobs(),
      renderer,
      baseUrl: "https://d.to",
      secret: "test-secret",
    })

    expect(n).toBe(1)
    // URL contains the raw route with shortId
    expect(seen[0]).toContain("/raw/")
    expect(seen[0]).toContain("short1")
    // The preview token rides as a path segment so bundle sub-assets inherit it
    expect(seen[0]).toContain("/pv/")
    // Version is now ready
    expect(fakes.versions.get("a1:1")?.preview_status).toBe("ready")
    expect(fakes.versions.get("a1:1")?.preview_key).toBeTruthy()
    expect(fakes.versions.get("a1:1")?.preview_error).toBeNull()
    // Job is done
    const job = [...fakes.jobs.values()][0]
    if (!job) throw new Error("expected a render job")
    expect(job.status).toBe("done")
  })

  it("Test A3: a variant failure never fails the OG render or the job — independent status per variant", async () => {
    const fakes = makeFakes()
    await seedArtifact(fakes, { id: "a1f", shortId: "short1f", versionN: 1 })

    // Only the MARKED request fails (it's the one with &marks=1); OG and full succeed.
    const renderer = {
      screenshot: async (url: string): Promise<Uint8Array> => {
        if (url.includes("marks=1")) throw new Error("marked render crashed")
        return new Uint8Array([1, 2, 3])
      },
    }

    await enqueueRender(fakes.meta, "a1f", 1)
    const n = await runRenderTick({
      meta: fakes.meta,
      blobs: makeBlobs(),
      renderer,
      baseUrl: "https://d.to",
      secret: "test-secret",
    })
    expect(n).toBe(1)

    const v = fakes.versions.get("a1f:1")
    // The OG image (what unfurls depend on) is unaffected by the marked failure.
    expect(v?.preview_status).toBe("ready")
    expect(v?.preview_full_status).toBe("ready")
    expect(v?.preview_marked_status).toBe("failed")
    expect(v?.preview_marked_error).toContain("marked render crashed")
    // The job itself completes normally — a variant failure is never retried via
    // the job queue, so it must not leave the OG render's own job stuck pending.
    const job = [...fakes.jobs.values()][0]
    if (!job) throw new Error("expected a render job")
    expect(job.status).toBe("done")
  })

  it("Test A4 (regression): the metastore itself failing to RECORD a variant failure must never corrupt the already-successful OG status or requeue the job", async () => {
    const fakes = makeFakes({
      // Simulate a transient metastore error specifically when writing the MARKED
      // variant's "failed" status — i.e. the render genuinely crashed AND the store
      // couldn't even record that fact. renderPreviewVariant's own catch block used
      // to let this exception escape, where the OUTER catch in runRenderTick mistook
      // it for the OG render itself failing — overwriting an already-ready, already-
      // stored OG image back to "failed" and requeuing the whole job pointlessly.
      failVariantWrite: (variant, status) => variant === "marked" && status === "failed",
    })
    await seedArtifact(fakes, { id: "a1r", shortId: "short1r", versionN: 1 })

    const renderer = {
      screenshot: async (url: string): Promise<Uint8Array> => {
        if (url.includes("marks=1")) throw new Error("marked screenshot genuinely crashed")
        return new Uint8Array([1, 2, 3])
      },
    }

    await enqueueRender(fakes.meta, "a1r", 1)
    const n = await runRenderTick({
      meta: fakes.meta,
      blobs: makeBlobs(),
      renderer,
      baseUrl: "https://d.to",
      secret: "test-secret",
    })
    expect(n).toBe(1)

    const v = fakes.versions.get("a1r:1")
    // The genuinely-successful OG and full renders must stay ready — a metastore
    // failure recording an UNRELATED variant's failure must not corrupt them.
    expect(v?.preview_status).toBe("ready")
    expect(v?.preview_full_status).toBe("ready")
    // The job completes normally, not requeued for a pointless full re-render.
    const job = [...fakes.jobs.values()][0]
    if (!job) throw new Error("expected a render job")
    expect(job.status).toBe("done")
  })

  it("Test A5 (regression): the job-completion write is made right after the OG write, BEFORE the variant renders — so if it fails, the two variant screenshots are never wastefully attempted", async () => {
    const fakes = makeFakes({
      // The job's "done" write throws every time (a transient metastore error) — the
      // retry's own "pending"/"dead" writes must still succeed, or this test can't
      // observe the resulting state.
      failUpdateRenderJob: (fields) => fields.status === "done",
    })
    await seedArtifact(fakes, { id: "a1o", shortId: "short1o", versionN: 1 })

    const seen: string[] = []
    const renderer = {
      screenshot: async (url: string) => {
        seen.push(url)
        return new Uint8Array([1, 2, 3])
      },
    }

    await enqueueRender(fakes.meta, "a1o", 1)
    const n = await runRenderTick({
      meta: fakes.meta,
      blobs: makeBlobs(),
      renderer,
      baseUrl: "https://d.to",
      secret: "test-secret",
    })
    expect(n).toBe(1)

    // Only the OG screenshot ran — the job-completion write throwing short-circuits
    // straight to the outer catch, so the full/marked screenshots (each up to
    // RENDER_TIMEOUT_MS) are never attempted at all, not run-then-discarded.
    expect(seen).toHaveLength(1)

    const v = fakes.versions.get("a1o:1")
    // The OG screenshot genuinely succeeded and its key was stored before the failed
    // write — the outer catch's failure write only touches status/error, so the good
    // key survives even though status is (correctly, per existing behavior) reported
    // "failed" until the retry lands.
    expect(v?.preview_key).toBeTruthy()
    expect(v?.preview_status).toBe("failed")
    // Neither variant ever got a chance to record a status.
    expect(v?.preview_full_status).toBeNull()
    expect(v?.preview_marked_status).toBeNull()

    const job = [...fakes.jobs.values()][0]
    if (!job) throw new Error("expected a render job")
    expect(job.status).toBe("pending")
  })

  it("Test B (failure): renderer throws → version failed + job pending with future next_attempt_at", async () => {
    const fakes = makeFakes()
    await seedArtifact(fakes, { id: "a2", shortId: "short2", versionN: 1 })

    const renderer = {
      screenshot: async (_url: string): Promise<Uint8Array> => {
        throw new Error("browser crashed")
      },
    }

    await enqueueRender(fakes.meta, "a2", 1)
    const before = Date.now()

    const n = await runRenderTick({
      meta: fakes.meta,
      blobs: makeBlobs(),
      renderer,
      baseUrl: "https://d.to",
      secret: "test-secret",
    })

    expect(n).toBe(1)
    expect(fakes.versions.get("a2:1")?.preview_status).toBe("failed")
    expect(fakes.versions.get("a2:1")?.preview_error).toBeTruthy()
    const job = [...fakes.jobs.values()][0]
    if (!job) throw new Error("expected a render job")
    expect(job.status).toBe("pending")
    // next_attempt_at should be in the future
    expect(new Date(job.next_attempt_at).getTime()).toBeGreaterThan(before)
  })

  it("Test B (dead): after MAX_ATTEMPTS failures → job becomes dead", async () => {
    const fakes = makeFakes()
    await seedArtifact(fakes, { id: "a3", shortId: "short3", versionN: 1 })

    const renderer = {
      screenshot: async (_url: string): Promise<Uint8Array> => {
        throw new Error("persistent failure")
      },
    }

    await enqueueRender(fakes.meta, "a3", 1)

    // Run MAX_ATTEMPTS times; each attempt increments the counter
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      // Reset next_attempt_at so it's always claimable
      const loopJob = [...fakes.jobs.values()][0]
      if (!loopJob) throw new Error("expected a render job in loop iteration")
      loopJob.next_attempt_at = new Date(0).toISOString()
      loopJob.status = "pending"
      await runRenderTick({
        meta: fakes.meta,
        blobs: makeBlobs(),
        renderer,
        baseUrl: "https://d.to",
        secret: "test-secret",
      })
    }

    const job = [...fakes.jobs.values()][0]
    if (!job) throw new Error("expected a render job after loop")
    expect(job.status).toBe("dead")
  })

  it("Test C: job whose version_n is no longer current → job done, renderer NOT called", async () => {
    const fakes = makeFakes()
    // Artifact is at version 2, but we'll queue a job for version 1
    await seedArtifact(fakes, {
      id: "a4",
      shortId: "short4",
      versionN: 1,
      currentVersion: 2, // version 1 is stale
    })
    // Also add v2 record so getVersion for v2 would work if needed
    fakes.versions.set("a4:2", {
      id: "v_a4_2",
      artifact_id: "a4",
      n: 2,
      blob_key: "blob2",
      content_type: "text/html",
      size_bytes: 100,
      author: "tester",
      author_login: null,
      author_avatar: null,
      author_gh_id: null,
      author_id: null,
      message: null,
      name: null,
      preview_key: null,
      preview_status: null,
      preview_error: null,
      preview_full_key: null,
      preview_full_status: null,
      preview_full_error: null,
      preview_marked_key: null,
      preview_marked_status: null,
      preview_marked_error: null,
      created_at: new Date().toISOString(),
    })

    const rendererCalled: string[] = []
    const renderer = {
      screenshot: async (url: string) => {
        rendererCalled.push(url)
        return new Uint8Array([1, 2, 3])
      },
    }

    await enqueueRender(fakes.meta, "a4", 1)

    const n = await runRenderTick({
      meta: fakes.meta,
      blobs: makeBlobs(),
      renderer,
      baseUrl: "https://d.to",
      secret: "test-secret",
    })

    expect(n).toBe(1)
    // Renderer must NOT have been called
    expect(rendererCalled).toHaveLength(0)
    // Job is done (skipped, not failed)
    const job = [...fakes.jobs.values()][0]
    if (!job) throw new Error("expected a render job")
    expect(job.status).toBe("done")
    // No preview written on the stale version
    expect(fakes.versions.get("a4:1")?.preview_status).toBeNull()
  })
})

describe("sweepMissingRenders", () => {
  it("enqueues a job for a never-rendered current version, and the next tick renders it", async () => {
    const fakes = makeFakes()
    // Published without ever enqueuing a render (e.g. an MCP publish before the fix).
    await seedArtifact(fakes, { id: "s1", shortId: "sshort1", versionN: 1 })
    expect(fakes.jobs.size).toBe(0)

    const swept = await sweepMissingRenders(fakes.meta)
    expect(swept).toBe(1)
    expect(fakes.jobs.size).toBe(1)

    const renderer = { screenshot: async () => new Uint8Array([9]) }
    await runRenderTick({
      meta: fakes.meta,
      blobs: makeBlobs(),
      renderer,
      baseUrl: "https://d.to",
      secret: "s",
    })
    expect(fakes.versions.get("s1:1")?.preview_status).toBe("ready")
  })

  it("does not duplicate a version that already has a pending job", async () => {
    const fakes = makeFakes()
    await seedArtifact(fakes, { id: "s2", shortId: "sshort2", versionN: 1 })
    await enqueueRender(fakes.meta, "s2", 1)

    expect(await sweepMissingRenders(fakes.meta)).toBe(0)
    expect(fakes.jobs.size).toBe(1)
  })

  it("never resurrects a version that rendered and failed", async () => {
    const fakes = makeFakes()
    await seedArtifact(fakes, { id: "s3", shortId: "sshort3", versionN: 1 })
    await fakes.meta.setVersionPreview("s3", 1, {
      preview_status: "failed",
      preview_error: "boom",
    })

    expect(await sweepMissingRenders(fakes.meta)).toBe(0)
    expect(fakes.jobs.size).toBe(0)
  })
})

describe("startPreviewWorker", () => {
  let timers: ReturnType<typeof setInterval>[] = []

  beforeEach(() => {
    timers = []
  })

  afterEach(() => {
    for (const t of timers) clearInterval(t)
  })

  // This test asserted nothing for a long time: it started a worker on a 100s
  // interval, called stop(), and carried the comment "no assertion needed — just
  // ensure it doesn't throw". Replacing the whole of stop() with an empty function
  // left it green, along with every other test in this file, which is the only
  // file that touches the preview worker. It named a guarantee nobody checked.
  //
  // What it has to do to be worth its name: leave real work queued, let the clock
  // pass several intervals AFTER stop(), and prove the renderer was never called.
  // Fake timers rather than a real sleep, so the assertion is about the contract
  // and not about how long the test is willing to wait.
  it("stop() prevents future ticks", async () => {
    vi.useFakeTimers()
    try {
      const fakes = makeFakes()
      await seedArtifact(fakes, { id: "a7", shortId: "short7", versionN: 1 })
      await enqueueRender(fakes.meta, "a7", 1)

      // A job IS waiting, so a tick that runs has something to render — without
      // this the assertion below would hold for a worker that never stopped.
      const seen: string[] = []
      const renderer = {
        screenshot: async (url: string) => {
          seen.push(url)
          return new Uint8Array([7, 7, 7])
        },
      }
      const worker = startPreviewWorker(
        {
          meta: fakes.meta,
          blobs: makeBlobs(),
          renderer,
          baseUrl: "https://d.to",
          secret: "s",
        },
        1_000,
      )

      worker.stop()
      await vi.advanceTimersByTimeAsync(10_000) // ten intervals' worth

      expect(seen).toEqual([])
      // The job is still sitting there unclaimed — the worker did not merely skip
      // rendering, it never took the work at all.
      expect([...fakes.jobs.values()].map((job) => job.status)).toEqual(["pending"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("poke() triggers a tick immediately", async () => {
    const fakes = makeFakes()
    await seedArtifact(fakes, { id: "a6", shortId: "short6", versionN: 1 })
    await enqueueRender(fakes.meta, "a6", 1)

    const seen: string[] = []
    const renderer = {
      screenshot: async (url: string) => {
        seen.push(url)
        return new Uint8Array([7, 7, 7])
      },
    }

    const worker = startPreviewWorker(
      {
        meta: fakes.meta,
        blobs: makeBlobs(),
        renderer,
        baseUrl: "https://d.to",
        secret: "test-secret",
      },
      100_000,
    )
    // Await the drain itself. This used to sleep 50ms and hope, which raced the tick's
    // final status write on a loaded runner: the screenshot landed (`seen` filled) but
    // `preview_status` was still null, so the assertion below flaked. The interval here
    // is 100s and nothing else pokes, so this awaits exactly this tick to completion.
    await worker.poke()
    worker.stop()

    expect(seen.length).toBeGreaterThan(0)
    expect(fakes.versions.get("a6:1")?.preview_status).toBe("ready")
  })
})
