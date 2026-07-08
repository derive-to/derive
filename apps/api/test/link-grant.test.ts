import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// The round-4 link grant pair at the route layer: default resolution (explicit >
// workspace setting > factory), the public-coherence rule (states 15/16 of the
// table in docs/plans/link-grant.md are unrepresentable), set-on-create, and the
// PATCH update semantics. The access matrix itself is covered in @derive/core;
// scenario end-to-ends live in visibility.test.ts + comment-access.test.ts.
describe("the link grant pair: defaults, coherence, updates", () => {
  const ana: TestUser = { id: "u_lg_ana", email: "ana@lg.test", name: "Ana", username: "anal" }

  const patchAccess = (
    app: ReturnType<typeof makeAuthedApp>["app"],
    shortId: string,
    body: Record<string, unknown>,
  ) =>
    app.request(`/v1/artifacts/${shortId}/visibility`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(ana.email) },
      body: JSON.stringify(body),
    })

  it("factory default: private listing + Workspace · can comment", async () => {
    const { app } = makeAuthedApp("lg-factory", [ana], "editor")
    const a = await (await publishAs(app, "<h1>d</h1>", {}, as(ana.email))).json()
    expect(a).toMatchObject({
      visibility: "private",
      link_role: "commenter",
      link_audience: "org",
    })
  })

  it("the workspace default overrides the factory; an explicit field beats both", async () => {
    const { app } = makeAuthedApp("lg-settings", [ana], "editor")
    await app.request("/v1/workspace/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(ana.email) },
      body: JSON.stringify({ defaultLinkRole: "viewer", defaultLinkAudience: "public" }),
    })
    // Workspace default applies (an unlisted world view-link — scenario 2 as policy).
    const a = await (await publishAs(app, "<h1>a</h1>", {}, as(ana.email))).json()
    expect(a).toMatchObject({ link_role: "viewer", link_audience: "public" })
    // Explicit request fields beat the setting.
    const b = await (
      await publishAs(
        app,
        "<h1>b</h1>",
        { link_role: "editor", link_audience: "org" },
        as(ana.email),
      )
    ).json()
    expect(b).toMatchObject({ link_role: "editor", link_audience: "org" })
  })

  it("a bare visibility=public publish gets the classic pair (public · viewer), never the workspace role", async () => {
    const { app } = makeAuthedApp("lg-public-bare", [ana], "editor")
    // The workspace default (commenter) is chosen for the WORKSPACE audience — a
    // world link must not silently inherit it (pre-round-4 public = view-only link).
    const a = await (
      await publishAs(app, "<h1>p</h1>", { visibility: "public" }, as(ana.email))
    ).json()
    expect(a).toMatchObject({
      visibility: "public",
      link_role: "viewer",
      link_audience: "public",
    })
    // Explicitly widening a public link still works.
    const b = await (
      await publishAs(
        app,
        "<h1>q</h1>",
        { visibility: "public", link_role: "commenter" },
        as(ana.email),
      )
    ).json()
    expect(b).toMatchObject({ link_role: "commenter", link_audience: "public" })
  })

  it("coherence: public + org audience / none role are 400s, on publish and PATCH", async () => {
    const { app } = makeAuthedApp("lg-coherence", [ana], "editor")
    expect(
      (
        await publishAs(
          app,
          "<h1>x</h1>",
          { visibility: "public", link_audience: "org" },
          as(ana.email),
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await publishAs(
          app,
          "<h1>x</h1>",
          { visibility: "public", link_role: "none" },
          as(ana.email),
        )
      ).status,
    ).toBe(400)
    const a = await (await publishAs(app, "<h1>x</h1>", {}, as(ana.email))).json()
    expect(
      (await patchAccess(app, a.short_id, { visibility: "public", linkAudience: "org" })).status,
    ).toBe(400)
    expect(
      (await patchAccess(app, a.short_id, { visibility: "public", linkRole: "none" })).status,
    ).toBe(400)
  })

  it("PATCH updates the pair independently and preserves omitted halves", async () => {
    const { app } = makeAuthedApp("lg-patch", [ana], "editor")
    const a = await (await publishAs(app, "<h1>d</h1>", {}, as(ana.email))).json()
    // Widen the audience, keep the role.
    let r = await (
      await patchAccess(app, a.short_id, { visibility: "private", linkAudience: "public" })
    ).json()
    expect(r).toMatchObject({ link_role: "commenter", link_audience: "public" })
    // Change the role, keep the audience.
    r = await (
      await patchAccess(app, a.short_id, { visibility: "private", linkRole: "viewer" })
    ).json()
    expect(r).toMatchObject({ link_role: "viewer", link_audience: "public" })
    // Bare visibility change: both halves carried over.
    r = await (await patchAccess(app, a.short_id, { visibility: "org" })).json()
    expect(r).toMatchObject({ link_role: "viewer", link_audience: "public" })
    // Dial to inert (invite-only): the URL stops working for a non-member holder.
    await patchAccess(app, a.short_id, { visibility: "private", linkRole: "none" })
    expect((await app.request(`/v1/artifacts/${a.short_id}`)).status).toBe(404)
  })

  it("going public coerces a carried-over inert/org link to the classic public pair", async () => {
    const { app } = makeAuthedApp("lg-public-carry", [ana], "editor")
    const a = await (
      await publishAs(app, "<h1>d</h1>", { link_role: "none" }, as(ana.email))
    ).json()
    // No explicit link fields with the flip: current none/org resolve to viewer/public
    // (what a legacy visibility=public change always meant: world-readable).
    const r = await (await patchAccess(app, a.short_id, { visibility: "public" })).json()
    expect(r).toMatchObject({
      visibility: "public",
      link_role: "viewer",
      link_audience: "public",
    })
    expect((await app.request(`/v1/artifacts/${a.short_id}`)).status).toBe(200)
  })

  it("the pair is set-on-create: a republish never re-stamps it", async () => {
    const { app } = makeAuthedApp("lg-republish", [ana], "editor")
    const a = await (await publishAs(app, "<h1>v1</h1>", {}, as(ana.email))).json()
    // Change the workspace default AFTER the publish; republishing must not widen.
    await app.request("/v1/workspace/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(ana.email) },
      body: JSON.stringify({ defaultLinkAudience: "public" }),
    })
    const v2 = await (
      await publishAs(
        app,
        "<h1>v2</h1>",
        { link_role: "editor", link_audience: "public" }, // ignored on republish
        as(ana.email),
        a.short_id,
      )
    ).json()
    expect(v2).toMatchObject({ link_role: "commenter", link_audience: "org" })
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
    expect(a).toMatchObject({ link_role: "commenter", link_audience: "public" })
    // Pre-collapse visibility=link maps to public (round 3) and lands the classic pair.
    const b = await (
      await publishAs(app, "<h1>m</h1>", { visibility: "link" }, as(ana.email))
    ).json()
    expect(b).toMatchObject({
      visibility: "public",
      link_role: "viewer",
      link_audience: "public",
    })
    // Legacy PATCH generalRole still lands on the pair.
    const r = await (
      await patchAccess(app, a.short_id, { visibility: "public", generalRole: "viewer" })
    ).json()
    expect(r).toMatchObject({ link_role: "viewer", link_audience: "public" })
  })

  it("an agent publish resolves the same default chain (draft listing, live workspace link)", async () => {
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
    // defaultAgentVisibility keeps the draft out of the library; the link pair is
    // the workspace default, so the human's teammates can open the paste.
    expect(a).toMatchObject({
      visibility: "private",
      link_role: "commenter",
      link_audience: "org",
    })
  })
})
