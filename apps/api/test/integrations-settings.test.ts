import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

const owner: TestUser = { id: "u-own", email: "own@x.com", name: "Owner", username: "owner" }
const editor: TestUser = { id: "u-ed", email: "ed@x.com", name: "Ed", username: "ed" }

const { app } = makeAuthedApp("integ-settings", [owner, editor], "editor")

describe("workspace integration settings", () => {
  it("defaults to all channels enabled", async () => {
    const r = await app.request("/v1/workspace/settings", { headers: as(owner.email) })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      emailNotifications: true,
      githubPostComments: true,
      githubMirrorComments: true,
      githubPreviewLink: true,
      slackPost: true,
      // The access NEW publishes land with — the team draft (see access-model.md).
      defaultWorkspaceAccess: "member",
      defaultLinkRole: "none",
      defaultListed: "none",
    })
  })

  it("an admin can flip a single toggle; the rest are unchanged", async () => {
    const r = await app.request("/v1/workspace/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(owner.email) },
      body: JSON.stringify({ slackPost: false }),
    })
    expect(r.status).toBe(200)
    const s = await r.json()
    expect(s.slackPost).toBe(false)
    expect(s.emailNotifications).toBe(true)
    // Persisted across reads.
    const again = await (
      await app.request("/v1/workspace/settings", { headers: as(owner.email) })
    ).json()
    expect(again.slackPost).toBe(false)
  })

  it("a non-admin can read but not change settings", async () => {
    const read = await app.request("/v1/workspace/settings", { headers: as(editor.email) })
    expect(read.status).toBe(200)
    const write = await app.request("/v1/workspace/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(editor.email) },
      body: JSON.stringify({ emailNotifications: false }),
    })
    expect(write.status).toBe(403)
  })

  it("requires authentication", async () => {
    const r = await app.request("/v1/workspace/settings")
    expect(r.status).toBe(401)
  })
})

// A Brandprint is a pointer to a conventions collection, so PATCH validates
// OWNERSHIP (not just shape) on write — the store deliberately doesn't (routes
// validate membership before calling, the store does not), so a hand-crafted
// collectionId pointing at another tenant's collection must be rejected here.
// jsonAs() is POST-only (see helpers.ts), so settings PATCHes build headers by hand.
const patchSettings = (
  a: ReturnType<typeof makeAuthedApp>["app"],
  headers: Record<string, string>,
  body: unknown,
) =>
  a.request("/v1/workspace/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })

describe("workspace Brandprint (write-side ownership check)", () => {
  it("accepts a collectionId owned by the active workspace", async () => {
    const admin: TestUser = { id: "u-bp-own", email: "bpown@x.com", name: "Own", username: "bpown" }
    const { app } = makeAuthedApp("integ-bp-ok", [admin])
    const col = await (
      await app.request("/v1/collections", jsonAs(as(admin.email), { title: "Brandprint" }))
    ).json()

    const r = await patchSettings(app, as(admin.email), { brandprint: { collectionId: col.id } })
    expect(r.status).toBe(200)
    expect((await r.json()).brandprint).toEqual({ collectionId: col.id })
  })

  it("rejects an unknown collectionId, and one owned by another workspace", async () => {
    const admin: TestUser = { id: "u-bp-bad", email: "bpbad@x.com", name: "Bad", username: "bpbad" }
    const { app, meta } = makeAuthedApp("integ-bp-bad", [admin])

    const unknown = await patchSettings(app, as(admin.email), {
      brandprint: { collectionId: "col_ghost" },
    })
    expect(unknown.status).toBe(400)

    // A real collection, but owned by a DIFFERENT tenant — this is the
    // cross-tenant vector the fix closes: without ownership validation, a
    // hand-crafted PATCH could point this workspace's Brandprint at another
    // org's collection and have its artifact bodies served over MCP.
    await meta.createCollection({
      id: "col_other_org",
      org_id: "some-other-workspace",
      title: "Not this workspace's",
      created_by: "u_stranger",
    })
    const foreign = await patchSettings(app, as(admin.email), {
      brandprint: { collectionId: "col_other_org" },
    })
    expect(foreign.status).toBe(400)
  })

  it("still allows clearing the Brandprint, and strips a legacy theme patch", async () => {
    const admin: TestUser = { id: "u-bp-clr", email: "bpclr@x.com", name: "Clr", username: "bpclr" }
    const { app } = makeAuthedApp("integ-bp-clear", [admin])
    const col = await (
      await app.request("/v1/collections", jsonAs(as(admin.email), { title: "Brandprint" }))
    ).json()
    await patchSettings(app, as(admin.email), { brandprint: { collectionId: col.id } })

    // `theme` left the schema with Phase 2 (the profile's embedded tokens replaced it);
    // an old client sending one gets it stripped, and the pointer on file survives.
    const themed = await patchSettings(app, as(admin.email), {
      brandprint: { theme: { palette: { primary: "#111" } } },
    })
    expect(themed.status).toBe(200)
    expect((await themed.json()).brandprint).toEqual({ collectionId: col.id })

    // brandprint: null clears it outright, no validation needed.
    const cleared = await patchSettings(app, as(admin.email), { brandprint: null })
    expect(cleared.status).toBe(200)
    expect((await cleared.json()).brandprint).toBeUndefined()
  })

  it("accepts a profileId published in this workspace and round-trips it", async () => {
    const admin: TestUser = { id: "u-bp-pro", email: "bppro@x.com", name: "Pro", username: "bppro" }
    const { app } = makeAuthedApp("integ-bp-profile", [admin])
    const col = await (
      await app.request("/v1/collections", jsonAs(as(admin.email), { title: "Brandprint" }))
    ).json()
    const pub = await publishAs(
      app,
      "<h1>Brand profile</h1>",
      { title: "Brand profile" },
      as(admin.email),
    )
    const { short_id } = await pub.json()

    const r = await patchSettings(app, as(admin.email), {
      brandprint: { collectionId: col.id, profileId: short_id },
    })
    expect(r.status).toBe(200)
    expect((await r.json()).brandprint).toEqual({ collectionId: col.id, profileId: short_id })
  })

  it("rejects an unknown profileId, and one owned by another workspace", async () => {
    const admin: TestUser = { id: "u-bp-prf", email: "bpprf@x.com", name: "Prf", username: "bpprf" }
    const { app, meta } = makeAuthedApp("integ-bp-profile-bad", [admin])

    const unknown = await patchSettings(app, as(admin.email), {
      brandprint: { profileId: "s_ghost" },
    })
    expect(unknown.status).toBe(400)

    // Same cross-tenant vector as the collection pointer: a hand-crafted profileId
    // must not point this workspace's headline profile at another org's artifact.
    await meta.createArtifact({
      id: "a_foreign_profile",
      short_id: "s_foreign_profile",
      org_id: "some-other-workspace",
      slug: null,
      title: "Not this workspace's profile",
      workspace_access: "member",
      link_role: "viewer",
      listed: "none",
      kind: "file",
      spa: 0,
    })
    const foreign = await patchSettings(app, as(admin.email), {
      brandprint: { profileId: "s_foreign_profile" },
    })
    expect(foreign.status).toBe(400)
  })
})
