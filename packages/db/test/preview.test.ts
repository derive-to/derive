import { describe, expect, it } from "vitest"
import { SqliteMetaStore } from "../src/sqlite"

describe("version preview fields", () => {
  it("round-trips preview_key/status/error on the current version", async () => {
    const meta = new SqliteMetaStore(":memory:")
    const a = await meta.createArtifact({
      id: "a1",
      short_id: "s1",
      org_id: "o1",
      slug: null,
      title: "t",
      kind: "file",
      spa: 0,
    })
    await meta.addVersion(a.id, {
      id: "v1",
      blob_key: "k",
      content_type: "text/html",
      author: "me",
      message: null,
    })
    const before = await meta.getVersion(a.id, 1)
    expect(before?.preview_status).toBeNull()
    expect(before?.preview_key).toBeNull()
    expect(before?.preview_error).toBeNull()
    await meta.setVersionPreview(a.id, 1, { preview_key: "png-key", preview_status: "ready" })
    const after = await meta.getVersion(a.id, 1)
    expect(after?.preview_key).toBe("png-key")
    expect(after?.preview_status).toBe("ready")
    expect(after?.preview_error).toBeNull()
  })
})

describe("versionsMissingPreview", () => {
  const seed = async (meta: SqliteMetaStore, id: string) => {
    const a = await meta.createArtifact({
      id,
      short_id: `s_${id}`,
      org_id: "o1",
      slug: null,
      title: "t",
      kind: "file",
      spa: 0,
    })
    await meta.addVersion(a.id, {
      id: `v_${id}`,
      blob_key: "k",
      content_type: "text/html",
      author: "me",
      message: null,
    })
    return a
  }

  it("finds only never-rendered current versions of live artifacts", async () => {
    const meta = new SqliteMetaStore(":memory:")
    await seed(meta, "a1") // never rendered → in
    const ready = await seed(meta, "a2")
    await meta.setVersionPreview(ready.id, 1, { preview_key: "k", preview_status: "ready" })
    const failed = await seed(meta, "a3")
    await meta.setVersionPreview(failed.id, 1, { preview_status: "failed", preview_error: "x" })
    const removed = await seed(meta, "a4")
    await meta.setArtifactRemoved(removed.id, new Date().toISOString())
    const queued = await seed(meta, "a5") // pending job already → out
    await meta.enqueueRenderJob({ id: "rj_a5", artifact_id: queued.id, version_n: 1 })

    const missing = await meta.versionsMissingPreview(10)
    expect(missing).toEqual([{ artifact_id: "a1", n: 1 }])
  })

  it("respects the limit", async () => {
    const meta = new SqliteMetaStore(":memory:")
    await seed(meta, "b1")
    await seed(meta, "b2")
    expect(await meta.versionsMissingPreview(1)).toHaveLength(1)
    expect(await meta.versionsMissingPreview(10)).toHaveLength(2)
  })
})
