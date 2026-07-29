import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// RENAME RE-DERIVES THE URL NAME.
//
// The slug was computed once, at create, from the title — and never again. Renaming a doc
// updated only `title`, so every link it handed out kept advertising the former name, and
// there was no lever to fix it: renaming IS the lever. Observed in production on a doc
// retitled "Agent ergonomics" whose url still read /artifacts/pr-559-what-was-actually-
// verified-<id>.
//
// Changing it is safe because the ref is `<slug>-<short_id>` and parseRef resolves on the
// TRAILING short id (packages/core/src/publish.ts) — the slug is decorative, so links
// already shared keep resolving. That property is what this test pins hardest.

const owner: TestUser = { id: "u_slug", email: "slug@derive.test", name: "Owner" }

describe("renaming an artifact re-derives its slug", () => {
  it("follows the new title, and the OLD url still resolves", async () => {
    const { app, meta } = makeAuthedApp("rename-slug", [owner], "editor")
    await app.request("/v1/me", { headers: as(owner.email) })

    const created = await publishAs(
      app,
      "# One\n\nbody",
      { title: "First Working Title" },
      as(owner.email),
    )
    const { short_id } = (await created.json()) as { short_id: string }
    const before = await meta.getByShortId(short_id)
    expect(before?.slug).toBe("first-working-title")

    // Rename through the ordinary publish path.
    await publishAs(
      app,
      "# One\n\nbody v2",
      { title: "A Much Better Name" },
      as(owner.email),
      short_id,
    )

    const after = await meta.getByShortId(short_id)
    expect(after?.title).toBe("A Much Better Name")
    expect(after?.slug).toBe("a-much-better-name")

    // THE PROPERTY THAT MAKES THIS SAFE: a link handed out under the old slug still
    // resolves, because the short id is the last segment and that is what is looked up.
    const old = await app.request(`/v1/artifacts/${short_id}`, { headers: as(owner.email) })
    expect(old.status).toBe(200)
    expect(((await old.json()) as { title: string }).title).toBe("A Much Better Name")
  })

  it("REPAIRS an artifact whose slug already drifted, even with the title unchanged", async () => {
    // The case that motivated the fix, and the one it originally missed. A doc renamed
    // before the slug followed along has a title that moved on and a url that did not —
    // and republishing under its CURRENT title changes nothing, because the title already
    // matches, so the only lever that could fix it never fires. It self-heals instead.
    const { app, meta } = makeAuthedApp("rename-slug-drifted", [owner], "editor")
    await app.request("/v1/me", { headers: as(owner.email) })
    const created = await publishAs(app, "# Old", { title: "Old Name" }, as(owner.email))
    const { short_id } = (await created.json()) as { short_id: string }
    const art = await meta.getByShortId(short_id)
    if (!art) throw new Error("artifact missing")

    // Exactly the pre-fix state: title advanced, slug left behind.
    await meta.setArtifactTitle(art.id, "Agent Ergonomics")
    expect((await meta.getByShortId(short_id))?.slug).toBe("old-name")

    // A republish carrying the CURRENT title — no rename at all.
    const out = await publishAs(
      app,
      "# Old v2",
      { title: "Agent Ergonomics" },
      as(owner.email),
      short_id,
    )
    const { url } = (await out.json()) as { url: string }
    expect((await meta.getByShortId(short_id))?.slug).toBe("agent-ergonomics")
    expect(url).toContain("agent-ergonomics")
    expect(url).not.toContain("old-name")
  })

  it("leaves the slug alone when the republish carries no title", async () => {
    // A CLI republish without --title must not rename anything, so it must not re-slug
    // either: the name is the human's, not a side effect of pushing content.
    const { app, meta } = makeAuthedApp("rename-slug-untouched", [owner], "editor")
    await app.request("/v1/me", { headers: as(owner.email) })
    const created = await publishAs(
      app,
      "# Two\n\nbody",
      { title: "Keep This Name" },
      as(owner.email),
    )
    const { short_id } = (await created.json()) as { short_id: string }

    await publishAs(app, "# Two\n\nbody v2", {}, as(owner.email), short_id)

    const after = await meta.getByShortId(short_id)
    expect(after?.title).toBe("Keep This Name")
    expect(after?.slug).toBe("keep-this-name")
  })

  it("falls back to the short id alone when a title has no sluggable characters", async () => {
    // slugify strips to [a-z0-9-]; a title of only symbols yields "", which must become
    // null rather than a leading-hyphen ref like "-abc12345".
    const { app, meta } = makeAuthedApp("rename-slug-empty", [owner], "editor")
    await app.request("/v1/me", { headers: as(owner.email) })
    const created = await publishAs(app, "# Three\n\nbody", { title: "Nameable" }, as(owner.email))
    const { short_id } = (await created.json()) as { short_id: string }

    await publishAs(app, "# Three\n\nbody v2", { title: "＊＊＊" }, as(owner.email), short_id)

    const after = await meta.getByShortId(short_id)
    expect(after?.slug).toBeNull()
  })
})
