import type { CollectionPreview } from "@derive/core"
import { describe, expect, it } from "vitest"
import { collectionsJson } from "../src/lib/boot-shapes"

// The preview strip's byline heal, pinned at the pure function. An agent publish
// denormalizes the CLIENT's name onto the artifact ("Claude Code (derive)"), while
// author_id is the human it acted for — the digest's "recent editors" must show the
// person, not the connection, exactly as authorProfile does for artifact cards. The
// wire shape is what CollectionsView renders, so this is the whole contract.
describe("collectionsJson: the preview byline heal", () => {
  const col = {
    id: "col_1",
    org_id: "org_1",
    title: "Shelf",
    created_by: "u_rob",
    created_at: "2026-08-01T00:00:00.000Z",
    workspace_access: "member" as const,
    folder_id: null,
    count: 1,
  }
  const preview = (over: Partial<CollectionPreview> = {}): CollectionPreview => ({
    id: "a_1",
    short_id: "abc123",
    title: "Launch memo",
    current_version: 2,
    updated_at: "2026-08-02T00:00:00.000Z",
    has_preview: true,
    author_id: "u_rob",
    author_name: "Claude Code (derive)",
    author_login: null,
    author_avatar: null,
    ...over,
  })

  const shape = (
    previews: Record<string, CollectionPreview[]>,
    bylines: { id: string; name: string | null; username: string | null }[],
  ) =>
    collectionsJson([col], [], {}, "u_rob", false, new Set(), new Set(), previews, bylines)[0]
      ?.preview?.[0]

  it("shows the person the agent acted for, not the publishing client", () => {
    const entry = shape({ col_1: [preview()] }, [
      { id: "u_rob", name: "Rob Moore", username: "rob" },
    ])
    expect(entry?.author_name).toBe("Rob Moore")
  })

  it("falls back to the handle, then the denormalized name", () => {
    const handleOnly = shape({ col_1: [preview()] }, [{ id: "u_rob", name: null, username: "rob" }])
    expect(handleOnly?.author_name).toBe("rob")
    // No live row at all (auth tables absent, or the user was deleted): the stored
    // name stands rather than the entry going blank.
    const degraded = shape({ col_1: [preview()] }, [])
    expect(degraded?.author_name).toBe("Claude Code (derive)")
  })

  it("never heals across authors", () => {
    const entry = shape({ col_1: [preview({ author_id: "u_other" })] }, [
      { id: "u_rob", name: "Rob Moore", username: "rob" },
    ])
    expect(entry?.author_name).toBe("Claude Code (derive)")
  })
})
