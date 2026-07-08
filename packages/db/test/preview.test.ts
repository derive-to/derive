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
      visibility: "public",
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
