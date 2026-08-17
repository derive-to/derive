/**
 * Task 5: preview trigger — enqueue a render job on version.published,
 * gated by renderPreviews.
 *
 * We spy on meta.enqueueRenderJob directly (the only storage sink
 * enqueueRender uses), so the test is self-contained — no renderer needed.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NewRenderJob } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import type { AppDeps } from "../src/context"

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

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
const HUMAN_HEADER = { "x-test-user": HUMAN.email }

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

/** Publish a new version onto an existing artifact. */
const publishVersion = async (
  app: ReturnType<typeof createApp>,
  shortId: string,
  content = "<h1>v2</h1>",
) => {
  const form = new FormData()
  form.append("file", new Blob([new TextEncoder().encode(content)]), "f.html")
  return app.request(`/v1/artifacts/${shortId}/versions`, {
    method: "POST",
    body: form,
    headers: TOKEN_HEADER,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("preview-trigger: renderPreviews gating", () => {
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

  it("enqueues a job for a new version (republish) when renderPreviews is true", async () => {
    const { app, enqueuedJobs } = makeApp("trigger-on-v2", true)

    // First publish
    const r1 = await publishArtifact(app)
    expect(r1.status).toBe(201)
    const b1 = (await r1.json()) as { short_id: string }

    // Second publish (new version on same artifact)
    const r2 = await publishVersion(app, b1.short_id)
    expect(r2.status).toBe(201)
    const b2 = (await r2.json()) as { current_version: number }

    await new Promise((r) => setTimeout(r, 20))

    // Two publish events → two render jobs
    expect(enqueuedJobs).toHaveLength(2)
    const job1 = enqueuedJobs[1]
    if (!job1) throw new Error("expected enqueuedJobs[1]")
    expect(job1.version_n).toBe(b2.current_version)
  })

  it("does NOT enqueue any render jobs when renderPreviews is false/omitted", async () => {
    const { app, enqueuedJobs } = makeApp("trigger-off", false)

    const res = await publishArtifact(app)
    expect(res.status).toBe(201)

    await new Promise((r) => setTimeout(r, 20))

    expect(enqueuedJobs).toHaveLength(0)
  })

  it("pokePreviews is called after enqueue when renderPreviews is true", async () => {
    const { app, pokeCalls } = makeApp("trigger-poke", true)

    const res = await publishArtifact(app)
    expect(res.status).toBe(201)

    await new Promise((r) => setTimeout(r, 20))

    expect(pokeCalls.length).toBeGreaterThanOrEqual(1)
  })
})

describe("preview-trigger: artifact id passed correctly", () => {
  it("the enqueued job carries the INTERNAL artifact id (not short_id)", async () => {
    const { app, enqueuedJobs, meta } = makeApp("trigger-id-check", true)

    const res = await publishArtifact(app)
    expect(res.status).toBe(201)
    const body = (await res.json()) as { short_id: string }

    await new Promise((r) => setTimeout(r, 20))
    expect(enqueuedJobs).toHaveLength(1)

    const artifact = await meta.getByShortId(body.short_id)
    expect(artifact).not.toBeNull()
    const idCheckJob = enqueuedJobs[0]
    if (!idCheckJob) throw new Error("expected enqueuedJobs[0]")
    expect(idCheckJob.artifact_id).toBe(artifact?.id)
  })
})

describe("preview-trigger: approval path enqueues for the new version", () => {
  it("approving a proposal enqueues exactly ONE render job for the approved version", async () => {
    const { app, enqueuedJobs, meta } = makeApp("trigger-approve", true)

    // Publish the base artifact (version 1) — enqueues job #1
    const r1 = await publishArtifact(app)
    expect(r1.status).toBe(201)
    const b1 = (await r1.json()) as { short_id: string; current_version: number }
    const baseVersion = b1.current_version

    // Wait for the fire-and-forget to settle, then clear the counter
    await new Promise((r) => setTimeout(r, 20))
    const jobsAfterPublish = enqueuedJobs.length
    expect(jobsAfterPublish).toBe(1)

    // Create a proposal (does NOT go live, so no render job yet)
    const propForm = new FormData()
    propForm.append("file", new Blob([new TextEncoder().encode("<h1>proposed</h1>")]), "f.html")
    const pr = await app.request(`/v1/artifacts/${b1.short_id}/proposals`, {
      method: "POST",
      body: propForm,
      headers: TOKEN_HEADER,
    })
    expect(pr.status).toBe(201)
    const proposal = (await pr.json()) as { id: string }

    // The static token creates the proposal; a directly signed-in workspace
    // owner is the independent human decision-maker.
    await meta.setWorkspace("default", "Default")
    await meta.setMembership({
      id: "m_preview_owner",
      org_id: "default",
      user_id: HUMAN.id,
      role: "owner",
    })

    await new Promise((r) => setTimeout(r, 20))
    // Proposing must NOT trigger a render job
    expect(enqueuedJobs).toHaveLength(jobsAfterPublish)

    // Approve the proposal — this publishes a new version and must trigger a render
    const ap = await app.request(`/v1/artifacts/${b1.short_id}/proposals/${proposal.id}/approve`, {
      method: "POST",
      headers: HUMAN_HEADER,
    })
    expect(ap.status).toBe(200)
    const approved = (await ap.json()) as { published: number }
    const approvedVersion = approved.published
    expect(approvedVersion).toBeGreaterThan(baseVersion)

    await new Promise((r) => setTimeout(r, 20))

    // Exactly one more render job should have been enqueued (for the approved version)
    expect(enqueuedJobs).toHaveLength(jobsAfterPublish + 1)
    const approvalJob = enqueuedJobs[jobsAfterPublish]
    if (!approvalJob) throw new Error("expected render job from approval")
    expect(approvalJob.version_n).toBe(approvedVersion)
  })
})
