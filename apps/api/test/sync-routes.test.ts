import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { app, meta, postJson, upload } from "./helpers"

// A controllable fake GitHub for the "Sync now" route. Connect/list/disconnect
// don't fetch; only run does.
let tree: { path: string; sha: string; type: "blob" | "tree" }[] = []
const blobs: Record<string, string> = {}

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const s = String(url)
      if (s.includes("/git/trees/"))
        return new Response(JSON.stringify({ tree, truncated: false }), { status: 200 })
      const m = s.match(/\/git\/blobs\/([^/?]+)/)
      if (m) {
        const b = blobs[m[1] as string]
        return b == null ? new Response("nf", { status: 404 }) : new Response(b, { status: 200 })
      }
      return new Response("nf", { status: 404 })
    }),
  )
})
afterAll(() => vi.unstubAllGlobals())

describe("sync routes", () => {
  let id = ""
  let collectionId = ""

  it("connects a repo, normalizing the URL and redacting the token", async () => {
    const res = await postJson("/v1/sync/github", {
      repo: "https://github.com/acme/docs.git",
      token: "ghp_secret",
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      id: string
      collection_id: string
      repo: string
      token: string | null
      file_count: number
    }
    expect(body.repo).toBe("acme/docs") // normalized from the URL + .git
    expect(body.token).toBe("•••") // redacted, never echoed back
    expect(body.file_count).toBe(0)
    id = body.id
    collectionId = body.collection_id
  })

  it("dedups: re-connecting the same repo returns the existing source, not a duplicate", async () => {
    const res = await postJson("/v1/sync/github", { repo: "acme/docs" })
    expect(res.status).toBe(200) // not 201 — nothing new created
    const body = (await res.json()) as { id: string; collection_id: string }
    expect(body.id).toBe(id) // same source
    expect(body.collection_id).toBe(collectionId) // same collection, no second "GitHub: acme/docs"
  })

  it("rejects an invalid repo", async () => {
    const res = await postJson("/v1/sync/github", { repo: "not-a-repo" })
    expect(res.status).toBe(400)
  })

  it("lists sources with the token redacted", async () => {
    const res = await app.request("/v1/sync/github")
    const body = (await res.json()) as { sources: { id: string; token: string | null }[] }
    const src = body.sources.find((s) => s.id === id)
    expect(src?.token).toBe("•••")
  })

  it("Sync now mirrors the repo's docs (and skips non-doc files)", async () => {
    tree = [
      { path: "readme.md", sha: "r1", type: "blob" },
      { path: "logo.png", sha: "p1", type: "blob" },
    ]
    blobs.r1 = "# Readme"
    const res = await postJson(`/v1/sync/github/${id}/run`, {})
    // No background runner wired in tests → /run mirrors inline and returns the synced
    // source: status 200, file_count reflects the one mirrored doc.
    expect(res.status).toBe(200)
    const r = (await res.json()) as { file_count: number; last_status: string }
    expect(r.file_count).toBe(1)
    expect(r.last_status).toBe("ok")
    expect(await meta.collectionArtifactIds(collectionId)).toHaveLength(1)
  })

  it("a synced artifact is read-only: detail says managed, republish is 409", async () => {
    const ids = await meta.collectionArtifactIds(collectionId)
    const artId = ids[0]
    if (!artId) throw new Error("no synced artifact")
    const art = await meta.getArtifactById(artId)
    const shortId = art?.short_id ?? ""
    const detail = (await (await app.request(`/v1/artifacts/${shortId}`)).json()) as {
      managed?: boolean
    }
    expect(detail.managed).toBe(true)
    const republish = await upload("readme.md", "# edited in Dock", {}, shortId)
    expect(republish.status).toBe(409)
  })

  it("status endpoint returns the live progress + file count (cheap poll)", async () => {
    const res = await app.request(`/v1/sync/github/${id}/status`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      id: string
      file_count: number
      last_status: string | null
      progress: string | null
    }
    expect(body.id).toBe(id)
    expect(body.file_count).toBe(1) // the one doc mirrored by "Sync now" above
    expect(body.last_status).toBe("ok")
  })

  it("active endpoint lists only sources mid-sync", async () => {
    // Idle after the completed sync → not listed.
    const idle = (await (await app.request("/v1/sync/github/active")).json()) as {
      active: { id: string }[]
    }
    expect(idle.active.find((s) => s.id === id)).toBeUndefined()
    // Mark it mirroring → now listed (drives the global chip); clear → gone again.
    await meta.setRepoSourceProgress(
      id,
      JSON.stringify({
        phase: "mirroring",
        done: 1,
        total: 5,
        updatedAt: "2026-06-14T00:00:00.000Z",
      }),
    )
    const busy = (await (await app.request("/v1/sync/github/active")).json()) as {
      active: { id: string; progress: string | null }[]
    }
    const found = busy.active.find((s) => s.id === id)
    expect(found?.progress).toContain('"phase":"mirroring"')
    await meta.setRepoSourceProgress(id, null)
  })

  it("disconnects but keeps the mirrored docs", async () => {
    const res = await app.request(`/v1/sync/github/${id}`, { method: "DELETE" })
    expect(res.status).toBe(204)
    expect(await meta.collectionArtifactIds(collectionId)).toHaveLength(1)
    expect(await meta.getRepoSource(id)).toBeNull()
  })
})
