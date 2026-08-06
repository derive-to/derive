import { describe, expect, it } from "vitest"
import { as, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// POST /v1/artifacts/:shortId/use — "use this as a template". Signed-in only: any
// caller who can READ the source lands a copy in their active workspace at the
// workspace's own defaults. Anonymous clickers are deferred through login by the
// viewer (`?use=1`) instead of minting anything pre-auth. The copy re-points at
// the source blob (no bytes move) and records lineage in `derived_from`.

const ana: TestUser = { id: "u_use_ana", email: "ana@use.test", name: "Ana" }
const ben: TestUser = { id: "u_use_ben", email: "ben@use.test", name: "Ben" }

const BASE = "use-drafts.test"
const SECRET = "0".repeat(64)
const { app, meta } = makeAuthedApp("use-artifact", [ana, ben], "editor", {
  deps: { subdomainBase: BASE, encryptionKey: SECRET },
})

const use = (shortId: string, headers: Record<string, string> = {}) =>
  app.request(`/v1/artifacts/${shortId}/use`, { method: "POST", headers })

describe("signed-in use", () => {
  it("copies into the caller's workspace: same bytes, fresh identity, recorded lineage", async () => {
    const src = await (
      await publishAs(app, "<h1>Weekly deck</h1>", { title: "Weekly deck" }, as(ana.email))
    ).json()

    const res = await use(src.short_id, as(ben.email))
    expect(res.status).toBe(201)
    const copy = await res.json()
    expect(copy.short_id).toBeTruthy()
    expect(copy.short_id).not.toBe(src.short_id)
    expect(copy.title).toBe("Weekly deck")
    expect(copy.url).toContain(copy.short_id)

    // Same stored blob — the content round-trips without any re-upload.
    const served = await app.request(`/v1/artifacts/${copy.short_id}/content`, {
      headers: as(ben.email),
    })
    expect(await served.text()).toContain("Weekly deck")

    // Lineage: the copy knows which artifact it was derived from (by id, not short_id).
    const srcRow = await meta.getByShortId(src.short_id)
    const copyRow = await meta.getByShortId(copy.short_id)
    expect(copyRow?.derived_from).toBe(srcRow?.id)
    // Same blob key, so storage stays dedup'd.
    const srcV = await meta.getVersion(srcRow?.id as string, 1)
    const copyV = await meta.getVersion(copyRow?.id as string, 1)
    expect(copyV?.blob_key).toBe(srcV?.blob_key)
    expect(copyV?.message).toBe(`Derived from ${src.short_id}`)

    // The copy takes the WORKSPACE's defaults (the team draft), never the source's
    // access — and the copier owns it.
    expect(copyRow?.workspace_access).toBe("member")
    expect(copyRow?.link_role).toBe("none")
    expect(copyRow?.listed).toBe("none")
    const detail = await (
      await app.request(`/v1/artifacts/${copy.short_id}`, { headers: as(ben.email) })
    ).json()
    expect(detail.my_role).toBe("owner")
  })

  it("refuses a source the caller cannot read (404, existence never leaks)", async () => {
    // Invite-only: workspace gets nothing, no world link — Ben has no path in.
    const hidden = await (
      await publishAs(
        app,
        "<p>secret</p>",
        { workspace_access: "none", link_role: "none" },
        as(ana.email),
      )
    ).json()
    const res = await use(hidden.short_id, as(ben.email))
    expect(res.status).toBe(404)
  })
})

describe("anonymous callers", () => {
  it("is refused at the door even for a link-viewable source — no pre-auth copies", async () => {
    // A draft copy an anonymous holder can't edit delivers nothing the source page
    // doesn't already show, so the flow is deferred use (`?use=1` through login),
    // and the global anonymous-write gate refuses the bare POST outright.
    const src = await (
      await publishAs(
        app,
        "<h1>Public template</h1>",
        { title: "Public template", link_role: "viewer" },
        as(ana.email),
      )
    ).json()
    const res = await use(src.short_id) // no auth headers at all
    expect(res.status).toBe(403)
    // Nothing was minted anywhere for the click.
    expect(await meta.countArtifacts("ws_sys_drafts")).toBe(0)
  })
})

describe("guards", () => {
  it("refuses to use an unclaimed draft as a template (claim it first)", async () => {
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("<p>draft</p>")]), "page.html")
    const minted = await (await app.request("/v1/drafts", { method: "POST", body: form })).json()
    const res = await use(minted.short_id, as(ana.email))
    expect(res.status).toBe(403)
  })

  it("404s a source with no published content yet", async () => {
    const res = await use("zzzzzzzz", as(ana.email))
    expect(res.status).toBe(404)
  })
})
