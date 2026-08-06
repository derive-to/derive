import { describe, expect, it } from "vitest"
import { as, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// POST /v1/artifacts/:shortId/use — "use this as a template". Anyone who can READ
// the source gets a copy: signed-in callers land it in their active workspace at
// the workspace's own defaults; anonymous callers get an expiring claimable draft
// (the /v1/drafts shape). The copy re-points at the source blob (no bytes move)
// and records lineage in `derived_from`.

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

describe("anonymous use", () => {
  it("mints an expiring claimable draft copy of a link-viewable source", async () => {
    const src = await (
      await publishAs(
        app,
        "<h1>Public template</h1>",
        { title: "Public template", link_role: "viewer" },
        as(ana.email),
      )
    ).json()

    const res = await use(src.short_id) // no auth headers at all
    expect(res.status).toBe(201)
    const draft = await res.json()
    expect(draft.short_id).not.toBe(src.short_id)
    expect(draft.draft_url).toBe(`https://${draft.short_id}.${BASE}/`)
    expect(draft.claim_url).toContain("/claim/")
    expect(Date.parse(draft.expires_at)).toBeGreaterThan(Date.now())

    // The draft shape: held in the drafts org, link-viewer only, ownerless, lineage kept.
    const row = await meta.getByShortId(draft.short_id)
    const srcRow = await meta.getByShortId(src.short_id)
    expect(row?.org_id).toBe("ws_sys_drafts")
    expect(row?.workspace_access).toBe("none")
    expect(row?.link_role).toBe("viewer")
    expect(row?.listed).toBe("none")
    expect(row?.expires_at).toBeTruthy()
    expect(row?.derived_from).toBe(srcRow?.id)

    // Live on its own draft host, same bytes as the source.
    const served = await app.request(`http://${draft.short_id}.${BASE}/`)
    expect(served.status).toBe(200)
    expect(await served.text()).toContain("Public template")
  })

  it("cannot use a source that grants the world nothing (404)", async () => {
    const teamOnly = await (await publishAs(app, "<p>team</p>", {}, as(ana.email))).json()
    const res = await use(teamOnly.short_id)
    expect(res.status).toBe(404)
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
