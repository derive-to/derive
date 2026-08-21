import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

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
  it("is refused at the door even for a link-viewable source — nothing minted pre-auth", async () => {
    // The viewer defers signed-out clickers through login (`?use=1`); the bare
    // POST is refused by the global anonymous-write gate.
    const src = await (
      await publishAs(
        app,
        "<h1>Public template</h1>",
        { title: "Public template", link_role: "viewer" },
        as(ana.email),
      )
    ).json()
    const draftsBefore = await meta.countArtifacts("ws_sys_drafts")
    const res = await use(src.short_id) // no auth headers at all
    expect(res.status).toBe(403)
    expect(await meta.countArtifacts("ws_sys_drafts")).toBe(draftsBefore)
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
})

describe("fill", () => {
  // The fill-with-your-work pair on a derived copy. GET /v1/artifacts/:id/fill returns
  // the copyable prompt; POST delivers the identical instruction (fillInstruction is
  // the single source) to an agent's pull inbox, the rework-route pattern.

  const owner: TestUser = {
    id: "u_fill_own",
    email: "fillown@derive.test",
    name: "Owner",
    username: "fillown",
  }
  const editor: TestUser = {
    id: "u_fill_ed",
    email: "filled@derive.test",
    name: "Ed",
    username: "filled",
  }

  const { app, meta } = makeAuthedApp("fill", [owner, editor], "editor")

  // A template + a copy derived from it through the real route, as the editor.
  const derive = async () => {
    const src = await (
      await publishAs(app, "<h1>Weekly deck</h1>", { title: "Weekly deck" }, as(owner.email))
    ).json()
    const copy = await (
      await app.request(`/v1/artifacts/${src.short_id}/use`, {
        method: "POST",
        headers: as(editor.email),
      })
    ).json()
    return { src: src.short_id as string, copy: copy.short_id as string }
  }

  const addAgent = async (name: string) =>
    (await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name, role: "editor" }))
    ).json()) as { id: string; name: string; token: string }

  const getFill = (shortId: string, note?: string, who = editor.email) =>
    app.request(`/v1/artifacts/${shortId}/fill${note ? `?note=${encodeURIComponent(note)}` : ""}`, {
      headers: as(who),
    })
  const postFill = (shortId: string, body: Record<string, unknown> = {}, who = editor.email) =>
    app.request(`/v1/artifacts/${shortId}/fill`, jsonAs(as(who), body))

  describe("GET /fill — the copyable prompt", () => {
    it("409s notDerived for an artifact with no template lineage", async () => {
      const plain = await (await publishAs(app, "# Doc", {}, as(owner.email))).json()
      const res = await getFill(plain.short_id)
      expect(res.status).toBe(409)
      expect((await res.json()).code).toBe("notDerived")
    })

    it("409s sourceGone when the template was taken down", async () => {
      const { src, copy } = await derive()
      const srcRow = await meta.getByShortId(src)
      await meta.setArtifactRemoved(srcRow?.id as string, new Date().toISOString())
      const res = await getFill(copy)
      expect(res.status).toBe(409)
      expect((await res.json()).code).toBe("sourceGone")
    })
  })

  describe("POST /fill — the one-click ask", () => {
    it("lands the same instruction in the agent's inbox, once", async () => {
      const { src, copy } = await derive()
      const agent = await addAgent("Filler")
      const res = await postFill(copy, { note: "payments team only" })
      expect(res.status).toBe(201)

      const inbox = (await (
        await app.request("/v1/agent/inbox", { headers: bearer(agent.token) })
      ).json()) as { mentions: { body: string }[] }
      const body = inbox.mentions[0]?.body ?? ""
      expect(body).toContain(src)
      expect(body).toContain(copy)
      expect(body).toContain("From the requester: payments team only")

      // The pull queue holds one ask per (agent, artifact) until the agent acks.
      const again = await postFill(copy)
      expect(again.status).toBe(409)
      expect((await again.json()).code).toBe("alreadyQueued")
    })

    it("409s needsAgent when nobody can be asked, notDerived off-lineage", async () => {
      const lone = makeAuthedApp("fill-noagent", [owner, editor], "editor")
      const src = await (
        await publishAs(lone.app, "<h1>T</h1>", { title: "T" }, as(owner.email))
      ).json()
      const copy = await (
        await lone.app.request(`/v1/artifacts/${src.short_id}/use`, {
          method: "POST",
          headers: as(editor.email),
        })
      ).json()
      const res = await lone.app.request(
        `/v1/artifacts/${copy.short_id}/fill`,
        jsonAs(as(editor.email), {}),
      )
      expect(res.status).toBe(409)
      expect((await res.json()).code).toBe("needsAgent")

      const plain = await (await publishAs(app, "# P", {}, as(owner.email))).json()
      const off = await postFill(plain.short_id)
      expect(off.status).toBe(409)
      expect((await off.json()).code).toBe("notDerived")
    })
  })
})
