import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

describe("template libraries: pinned reusable starters", () => {
  const owner: TestUser = { id: "u_tpl_owner", email: "owner@templates.test", name: "Owner" }
  const teammate: TestUser = {
    id: "u_tpl_teammate",
    email: "teammate@templates.test",
    name: "Teammate",
  }
  const { app } = makeAuthedApp("template-libraries", [owner, teammate], "editor")

  it("pins source bytes, gates private libraries, and makes an explicit public snapshot shareable", async () => {
    const published = await publishAs(app, "# First version", {}, as(owner.email))
    const source = await published.json()
    const library = await (
      await app.request(
        "/v1/template-libraries",
        jsonAs(as(owner.email), {
          title: "Product starters",
          description: "Trusted decisions and planning docs.",
          scope: "private",
        }),
      )
    ).json()
    const entryRes = await app.request(
      `/v1/template-libraries/${library.id}/entries`,
      jsonAs(as(owner.email), {
        source_short_id: `trusted-decision-${source.short_id}@v1`,
        kind: "artifact",
        category: "Doc",
        format: "md",
        title: "Decision record",
        description: "The repeatable decision shape.",
        outcome: "A clear call with durable rationale.",
        sections: ["Decision", "Evidence", "Owner"],
        inputs: [],
        tags: ["decision"],
        theme_mode: "fixed",
      }),
    )
    expect(entryRes.status).toBe(201)
    const entry = await entryRes.json()

    // It is a private library, even to a teammate in the same workspace.
    expect(
      (await app.request(`/v1/template-libraries/${library.id}`, { headers: as(teammate.email) }))
        .status,
    ).toBe(404)

    // A later source revision never changes the entry's starter bytes.
    expect(
      (await publishAs(app, "# Second version", {}, as(owner.email), source.short_id)).status,
    ).toBe(201)
    const privateStarter = await (
      await app.request(`/v1/template-libraries/${library.id}/entries/${entry.id}/starter`, {
        headers: as(owner.email),
      })
    ).json()
    expect(privateStarter.source).toContain("First version")
    expect(privateStarter.source).not.toContain("Second version")
    expect(privateStarter.entry.source_version).toBe(1)

    // Distribution is an explicit library-level decision. Public entries now
    // serve to anonymous visitors without widening the original artifact itself.
    expect(
      (
        await app.request(`/v1/template-libraries/${library.id}`, {
          method: "PATCH",
          headers: { ...as(owner.email), "content-type": "application/json" },
          body: JSON.stringify({ scope: "public" }),
        })
      ).status,
    ).toBe(200)
    const anonymous = await app.request(`/v1/template-libraries/${library.id}`)
    expect(anonymous.status).toBe(200)
    expect((await anonymous.json()).entries).toHaveLength(1)
    const publicStarter = await app.request(
      `/v1/template-libraries/${library.id}/entries/${entry.id}/starter`,
    )
    expect(publicStarter.status).toBe(200)
    expect((await publicStarter.json()).source).toContain("First version")
  })

  it("shares workspace libraries with members and keeps context templates secret-free", async () => {
    const source = await (await publishAs(app, "# Team template", {}, as(owner.email))).json()
    const library = await (
      await app.request(
        "/v1/template-libraries",
        jsonAs(as(owner.email), { title: "Team starters", scope: "workspace" }),
      )
    ).json()
    const workspaceEntry = await app.request(
      `/v1/template-libraries/${library.id}/entries`,
      jsonAs(as(owner.email), {
        source_short_id: source.short_id,
        kind: "artifact",
        category: "Doc",
        format: "md",
        title: "Team note",
        description: "A shared note starter.",
        outcome: "A repeatable team update.",
        sections: [],
        inputs: [],
        tags: [],
        theme_mode: "fixed",
      }),
    )
    expect(workspaceEntry.status).toBe(201)
    expect(
      (await app.request(`/v1/template-libraries/${library.id}`, { headers: as(teammate.email) }))
        .status,
    ).toBe(200)

    const unsafe = await (
      await publishAs(app, "api_key: sk_thisIsClearlyNotATemplateSecret", {}, as(owner.email))
    ).json()
    const denied = await app.request(
      `/v1/template-libraries/${library.id}/entries`,
      jsonAs(as(owner.email), {
        source_short_id: unsafe.short_id,
        kind: "context",
        category: "Context",
        format: "md",
        title: "Unsafe context",
        description: "Should be rejected.",
        outcome: "Never ships credentials.",
        sections: [],
        inputs: [],
        tags: [],
        theme_mode: "fixed",
      }),
    )
    expect(denied.status).toBe(422)

    const safe = await (
      await publishAs(app, "# Safe context\n\napi_key: {{API_KEY}}", {}, as(owner.email))
    ).json()
    const allowed = await app.request(
      `/v1/template-libraries/${library.id}/entries`,
      jsonAs(as(owner.email), {
        source_short_id: safe.short_id,
        kind: "context",
        category: "Context",
        format: "md",
        title: "Bound context",
        description: "A portable manifest with a named credential binding.",
        outcome: "A safely configured Context.",
        sections: [],
        inputs: [],
        tags: ["context"],
        theme_mode: "fixed",
      }),
    )
    expect(allowed.status).toBe(201)
  })
})
