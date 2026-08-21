import { describe, expect, it } from "vitest"
import { SqliteMetaStore } from "../src/sqlite"

describe("previewReady", () => {
  it("returns true after current version preview_status is set to ready", async () => {
    const meta = new SqliteMetaStore(":memory:")
    const a = await meta.createArtifact({
      id: "a2",
      short_id: "s2",
      org_id: "o1",
      slug: null,
      title: "t",
      kind: "file",
      spa: 0,
    })
    await meta.addVersion(a.id, {
      id: "v2",
      blob_key: "k2",
      content_type: "text/html",
      author: "me",
      message: null,
    })
    await meta.setVersionPreview(a.id, 1, { preview_key: "png-k", preview_status: "ready" })
    const result = await meta.previewReady([a.id])
    expect(result[a.id]).toBe(true)
  })

  it("returns false when an old version is ready but the current version is not", async () => {
    const meta = new SqliteMetaStore(":memory:")
    const a = await meta.createArtifact({
      id: "a3",
      short_id: "s3",
      org_id: "o1",
      slug: null,
      title: "t",
      kind: "file",
      spa: 0,
    })
    // v1 — set ready
    await meta.addVersion(a.id, {
      id: "v3a",
      blob_key: "k3a",
      content_type: "text/html",
      author: "me",
      message: null,
    })
    await meta.setVersionPreview(a.id, 1, { preview_key: "old-png", preview_status: "ready" })
    // v2 — current version, NOT ready
    await meta.addVersion(a.id, {
      id: "v3b",
      blob_key: "k3b",
      content_type: "text/html",
      author: "me",
      message: null,
    })
    // current_version is now 2; v1 is ready but v2 is not
    const result = await meta.previewReady([a.id])
    expect(result[a.id]).toBeFalsy()
  })
})
