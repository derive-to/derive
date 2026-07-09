import { describe, expect, it } from "vitest"
import { SqliteMetaStore } from "../src/sqlite"

describe("previewReady", () => {
  it("returns {} for empty input", async () => {
    const meta = new SqliteMetaStore(":memory:")
    const result = await meta.previewReady([])
    expect(result).toEqual({})
  })

  it("returns false (missing) before any preview is set", async () => {
    const meta = new SqliteMetaStore(":memory:")
    const a = await meta.createArtifact({
      id: "a1",
      short_id: "s1",
      org_id: "o1",
      slug: null,
      title: "t",
      visibility: "public",
      kind: "file",
      spa: 0,
    })
    await meta.addVersion(a.id, {
      id: "v1",
      blob_key: "k1",
      content_type: "text/html",
      author: "me",
      message: null,
    })
    const result = await meta.previewReady([a.id])
    // missing id = false
    expect(result[a.id]).toBeFalsy()
  })

  it("returns true after current version preview_status is set to ready", async () => {
    const meta = new SqliteMetaStore(":memory:")
    const a = await meta.createArtifact({
      id: "a2",
      short_id: "s2",
      org_id: "o1",
      slug: null,
      title: "t",
      visibility: "public",
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
      visibility: "public",
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

  it("handles multiple artifacts correctly", async () => {
    const meta = new SqliteMetaStore(":memory:")
    const a1 = await meta.createArtifact({
      id: "b1",
      short_id: "sb1",
      org_id: "o1",
      slug: null,
      title: "t",
      visibility: "public",
      kind: "file",
      spa: 0,
    })
    const a2 = await meta.createArtifact({
      id: "b2",
      short_id: "sb2",
      org_id: "o1",
      slug: null,
      title: "t",
      visibility: "public",
      kind: "file",
      spa: 0,
    })
    await meta.addVersion(a1.id, {
      id: "vb1",
      blob_key: "kb1",
      content_type: "text/html",
      author: "me",
      message: null,
    })
    await meta.addVersion(a2.id, {
      id: "vb2",
      blob_key: "kb2",
      content_type: "text/html",
      author: "me",
      message: null,
    })
    await meta.setVersionPreview(a1.id, 1, { preview_key: "p1", preview_status: "ready" })
    // a2 left without a ready preview

    const result = await meta.previewReady([a1.id, a2.id])
    expect(result[a1.id]).toBe(true)
    expect(result[a2.id]).toBeFalsy()
  })
})
