import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// The v2 access model at the route layer: default resolution (explicit >
// workspace setting > factory), the two listing preconditions, set-on-create,
// the PATCH update semantics, and legacy-vocabulary compatibility. The access
// matrix itself is covered in @derive/core; scenario end-to-ends live in
// visibility.test.ts + comment-access.test.ts. See docs/plans/access-model.md.
describe("access resolution: defaults, preconditions, updates", () => {
  const ana: TestUser = { id: "u_lg_ana", email: "ana@lg.test", name: "Ana", username: "anal" }

  const patchAccess = (
    app: ReturnType<typeof makeAuthedApp>["app"],
    shortId: string,
    body: Record<string, unknown>,
  ) =>
    app.request(`/v1/artifacts/${shortId}/access`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(ana.email) },
      body: JSON.stringify(body),
    })

  it("factory default: the team draft — member / none / none", async () => {
    const { app } = makeAuthedApp("lg-factory", [ana], "editor")
    const a = await (await publishAs(app, "<h1>d</h1>", {}, as(ana.email))).json()
    expect(a).toMatchObject({
      workspace_access: "member",
      link_role: "none",
      listed: "none",
    })
  })

  it("the workspace default overrides the factory; an explicit field beats both", async () => {
    const { app } = makeAuthedApp("lg-settings", [ana], "editor")
    await app.request("/v1/workspace/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(ana.email) },
      body: JSON.stringify({ defaultLinkRole: "viewer", defaultListed: "public" }),
    })
    // Workspace default applies (a public view-linked publish as policy).
    const a = await (await publishAs(app, "<h1>a</h1>", {}, as(ana.email))).json()
    expect(a).toMatchObject({ link_role: "viewer", listed: "public" })
    // Explicit request fields beat the setting.
    const b = await (
      await publishAs(app, "<h1>b</h1>", { link_role: "editor", listed: "none" }, as(ana.email))
    ).json()
    expect(b).toMatchObject({ link_role: "editor", listed: "none" })
  })

  it("a legacy visibility=public publish maps onto the triple (member / viewer / public)", async () => {
    const { app } = makeAuthedApp("lg-public-bare", [ana], "editor")
    const a = await (
      await publishAs(app, "<h1>p</h1>", { visibility: "public" }, as(ana.email))
    ).json()
    expect(a).toMatchObject({
      workspace_access: "member",
      link_role: "viewer",
      listed: "public",
    })
  })

  it("preconditions: listing where there's no access is a 400, on publish and PATCH", async () => {
    const { app } = makeAuthedApp("lg-coherence", [ana], "editor")
    // listed=public with no world link.
    expect(
      (await publishAs(app, "<h1>x</h1>", { listed: "public", link_role: "none" }, as(ana.email)))
        .status,
    ).toBe(400)
    // listed=workspace with no workspace access.
    expect(
      (
        await publishAs(
          app,
          "<h1>x</h1>",
          { listed: "workspace", workspace_access: "none" },
          as(ana.email),
        )
      ).status,
    ).toBe(400)
    const a = await (await publishAs(app, "<h1>x</h1>", {}, as(ana.email))).json()
    expect((await patchAccess(app, a.short_id, { listed: "public" })).status).toBe(400)
    expect(
      (await patchAccess(app, a.short_id, { listed: "workspace", workspaceAccess: "none" })).status,
    ).toBe(400)
  })

  it("PATCH updates fields independently and preserves the omitted ones", async () => {
    const { app } = makeAuthedApp("lg-patch", [ana], "editor")
    const a = await (
      await publishAs(app, "<h1>d</h1>", { link_role: "viewer" }, as(ana.email))
    ).json()
    // Change the link role, keep workspace_access + listed.
    let r = await (await patchAccess(app, a.short_id, { linkRole: "commenter" })).json()
    expect(r).toMatchObject({ workspace_access: "member", link_role: "commenter", listed: "none" })
    // Promote listing, keep the rest.
    r = await (await patchAccess(app, a.short_id, { listed: "public" })).json()
    expect(r).toMatchObject({ link_role: "commenter", listed: "public" })
    // Drop the world link AND its listing: the URL stops working for an anon holder.
    await patchAccess(app, a.short_id, { linkRole: "none", listed: "none" })
    expect((await app.request(`/v1/artifacts/${a.short_id}`)).status).toBe(404)
  })

  it("access is set-on-create: a republish never re-stamps it", async () => {
    const { app } = makeAuthedApp("lg-republish", [ana], "editor")
    const a = await (await publishAs(app, "<h1>v1</h1>", {}, as(ana.email))).json()
    // Change the workspace default AFTER the publish; republishing must not widen.
    await app.request("/v1/workspace/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(ana.email) },
      body: JSON.stringify({ defaultListed: "public", defaultLinkRole: "viewer" }),
    })
    const v2 = await (
      await publishAs(
        app,
        "<h1>v2</h1>",
        { link_role: "editor", listed: "public" }, // ignored on republish
        as(ana.email),
        a.short_id,
      )
    ).json()
    expect(v2).toMatchObject({ workspace_access: "member", link_role: "none", listed: "none" })
  })

  it("legacy vocabulary: general_role + visibility=link keep working", async () => {
    const { app } = makeAuthedApp("lg-legacy", [ana], "editor")
    // Old field name on publish, with public visibility (the only place it traveled).
    const a = await (
      await publishAs(
        app,
        "<h1>l</h1>",
        { visibility: "public", general_role: "commenter" },
        as(ana.email),
      )
    ).json()
    expect(a).toMatchObject({ link_role: "commenter", listed: "public" })
    // Pre-collapse visibility=link maps to public and lands the public triple.
    const b = await (
      await publishAs(app, "<h1>m</h1>", { visibility: "link" }, as(ana.email))
    ).json()
    expect(b).toMatchObject({
      workspace_access: "member",
      link_role: "viewer",
      listed: "public",
    })
    // Legacy PATCH generalRole still lands on the link role.
    const r = await (await patchAccess(app, a.short_id, { generalRole: "viewer" })).json()
    expect(r).toMatchObject({ link_role: "viewer" })
  })

  it("an agent publish resolves the same default chain (team draft, unlisted)", async () => {
    const { app } = makeAuthedApp("lg-agent", [ana], "editor")
    await app.request("/v1/me", { headers: as(ana.email) })
    const reg = await (
      await app.request("/v1/agents", jsonAs(as(ana.email), { name: "Scribe", role: "editor" }))
    ).json()
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("# memo")]), "memo.md")
    const a = await (
      await app.request("/v1/artifacts", {
        method: "POST",
        body: form,
        headers: { authorization: `Bearer ${reg.token}` },
      })
    ).json()
    // The workspace default (the team draft) keeps the agent's publish out of the
    // library; the workspace reaches it at its seats until the human promotes it.
    expect(a).toMatchObject({
      workspace_access: "member",
      link_role: "none",
      listed: "none",
    })
  })

  it("a world-link editor may revise content but cannot change access or the lock", async () => {
    // Ben reaches Ana's artifact PURELY via an editor world-link — his own workspace,
    // no membership here, no explicit share. The link grants edit (content), but the
    // reach controls (/access, /locked) gate on STANDING, so the link can't bootstrap
    // widening itself, re-listing publicly, or clearing the lock. See access-model.md.
    const ben: TestUser = { id: "u_lg_ben", email: "ben@lg.test", name: "Ben", username: "benl" }
    const { app } = makeAuthedApp("lg-standing", [ana, ben], undefined, { isolated: true })
    await app.request("/v1/me", { headers: as(ana.email) }) // provision Ana's workspace
    const a = await (
      await publishAs(app, "<h1>d</h1>", { link_role: "editor" }, as(ana.email))
    ).json()
    expect(a.link_role).toBe("editor")

    // Content: the editor link lets Ben publish a new version.
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("<h1>v2</h1>")]), "d.html")
    expect(
      (
        await app.request(`/v1/artifacts/${a.short_id}/versions`, {
          method: "POST",
          body: form,
          headers: as(ben.email),
        })
      ).status,
    ).toBe(201)

    // Reach: Ben cannot re-list it publicly or toggle the change-lock — no standing.
    const patch = (path: string, body: object) =>
      app.request(`/v1/artifacts/${a.short_id}/${path}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...as(ben.email) },
        body: JSON.stringify(body),
      })
    expect((await patch("access", { listed: "public" })).status).toBe(403)
    expect((await patch("locked", { locked: true })).status).toBe(403)

    // The owner (real standing) still can.
    expect(
      (
        await app.request(`/v1/artifacts/${a.short_id}/access`, {
          method: "PATCH",
          headers: { "content-type": "application/json", ...as(ana.email) },
          body: JSON.stringify({ listed: "public" }),
        })
      ).status,
    ).toBe(200)
  })
})
