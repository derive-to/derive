import { newId } from "@derive/core"
import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

describe("template libraries: pinned reusable starters", () => {
  const owner: TestUser = { id: "u_tpl_owner", email: "owner@templates.test", name: "Owner" }
  const teammate: TestUser = {
    id: "u_tpl_teammate",
    email: "teammate@templates.test",
    name: "Teammate",
  }
  const { app, meta } = makeAuthedApp("template-libraries", [owner, teammate], "editor")
  const publishMarkdown = (
    content: string,
    fields: Record<string, string> = {},
    headers: Record<string, string> = {},
  ) => {
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode(content)]), "starter.md")
    for (const [key, value] of Object.entries(fields)) form.append(key, value)
    return app.request("/v1/artifacts", { method: "POST", body: form, headers })
  }

  it("pins source bytes, gates private libraries, and makes an explicit public snapshot shareable", async () => {
    const published = await publishMarkdown("# First version", {}, as(owner.email))
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
        title: "Decision record",
        description: "The repeatable decision shape.",
        outcome: "A clear call with durable rationale.",
        sections: ["Decision", "Evidence", "Owner"],
        inputs: [],
        tags: ["decision"],
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
    expect(privateStarter.entry.format).toBe("md")

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
    const publicLibrary = await anonymous.json()
    expect(publicLibrary.entries).toHaveLength(1)
    expect(publicLibrary.publisher).toMatchObject({ name: owner.name })
    const publicCatalog = await app.request("/v1/template-libraries")
    expect(publicCatalog.status).toBe(200)
    expect((await publicCatalog.json()).libraries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: library.id,
          publisher: expect.objectContaining({ name: owner.name }),
        }),
      ]),
    )
    const publicStarter = await app.request(
      `/v1/template-libraries/${library.id}/entries/${entry.id}/starter`,
    )
    expect(publicStarter.status).toBe(200)
    const reusable = await publicStarter.json()
    expect(reusable.source).toContain("First version")

    const sourceRow = await meta.getByShortId(source.short_id)
    if (!sourceRow) throw new Error("missing template source")
    await meta.deleteArtifact(sourceRow.id, sourceRow.org_id)
    const afterSourceDelete = await app.request(
      `/v1/template-libraries/${library.id}/entries/${entry.id}/starter`,
    )
    expect(afterSourceDelete.status).toBe(200)
    expect((await afterSourceDelete.json()).source).toContain("First version")
  })

  it("shares workspace libraries with members and keeps context templates secret-free", async () => {
    const source = await (await publishMarkdown("# Team template", {}, as(owner.email))).json()
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
        title: "Team note",
        description: "A shared note starter.",
        outcome: "A repeatable team update.",
        sections: [],
        inputs: [],
        tags: [],
      }),
    )
    expect(workspaceEntry.status).toBe(201)
    expect(
      (await app.request(`/v1/template-libraries/${library.id}`, { headers: as(teammate.email) }))
        .status,
    ).toBe(200)

    const unsafe = await (
      await publishMarkdown("api_key: sk_thisIsClearlyNotATemplateSecret", {}, as(owner.email))
    ).json()
    const denied = await app.request(
      `/v1/template-libraries/${library.id}/entries`,
      jsonAs(as(owner.email), {
        source_short_id: unsafe.short_id,
        kind: "context",
        category: "Context",
        title: "Unsafe context",
        description: "Should be rejected.",
        outcome: "Never ships credentials.",
        sections: [],
        inputs: [],
        tags: [],
      }),
    )
    expect(denied.status).toBe(422)

    const safe = await (
      await publishMarkdown("# Safe context\n\napi_key: {{API_KEY}}", {}, as(owner.email))
    ).json()
    const allowed = await app.request(
      `/v1/template-libraries/${library.id}/entries`,
      jsonAs(as(owner.email), {
        source_short_id: safe.short_id,
        kind: "context",
        category: "Context",
        title: "Bound context",
        description: "A portable manifest with a named credential binding.",
        outcome: "A safely configured Context.",
        sections: [],
        inputs: [],
        tags: ["context"],
      }),
    )
    expect(allowed.status).toBe(201)
  })

  it("derives format from pinned bytes and rejects ambiguous HTML bindings", async () => {
    const source = await (
      await publishAs(
        app,
        '<!doctype html><h1 data-project="{{Project}}">{{Project}}</h1>',
        {},
        as(owner.email),
      )
    ).json()
    const library = await (
      await app.request(
        "/v1/template-libraries",
        jsonAs(as(owner.email), { title: "HTML starters", scope: "workspace" }),
      )
    ).json()
    const unsafeBinding = await app.request(
      `/v1/template-libraries/${library.id}/entries`,
      jsonAs(as(owner.email), {
        source_short_id: source.short_id,
        kind: "artifact",
        category: "Site",
        title: "Project page",
        description: "A project page with a starting brief.",
        outcome: "A clear page.",
        sections: [],
        inputs: [{ name: "Project", description: "Project name", required: true }],
        tags: [],
      }),
    )
    expect(unsafeBinding.status).toBe(422)
    expect(await unsafeBinding.text()).toMatch(/visible text/i)

    const duplicateInputs = await app.request(
      `/v1/template-libraries/${library.id}/entries`,
      jsonAs(as(owner.email), {
        source_short_id: source.short_id,
        kind: "artifact",
        category: "Site",
        title: "Project page",
        description: "A project page with a starting brief.",
        outcome: "A clear page.",
        sections: [],
        inputs: [
          { name: "Project", description: "Project name" },
          { name: "project", description: "Duplicate project name" },
        ],
        tags: [],
      }),
    )
    expect(duplicateInputs.status).toBe(422)
    expect(await duplicateInputs.text()).toMatch(/unique/i)
  })

  it("does not let read-only access widen a private source through a library", async () => {
    const sourceJson = await (
      await publishAs(
        app,
        "# Invite-only strategy",
        { workspace_access: "none", link_role: "none" },
        as(owner.email),
      )
    ).json()
    const source = await meta.getByShortId(sourceJson.short_id)
    if (!source) throw new Error("missing private source")
    await meta.setArtifactMember({
      id: newId("am"),
      artifact_id: source.id,
      user_id: teammate.id,
      role: "viewer",
    })

    const privateLibrary = await (
      await app.request(
        "/v1/template-libraries",
        jsonAs(as(teammate.email), { title: "My private references", scope: "private" }),
      )
    ).json()
    const entryBody = {
      source_short_id: source.short_id,
      kind: "artifact",
      category: "Doc",
      title: "Private strategy",
      description: "A privately reusable reference.",
      outcome: "A tailored strategy.",
      sections: [],
      inputs: [],
      tags: [],
    }
    expect(
      (
        await app.request(
          `/v1/template-libraries/${privateLibrary.id}/entries`,
          jsonAs(as(teammate.email), entryBody),
        )
      ).status,
    ).toBe(201)
    const widen = await app.request(`/v1/template-libraries/${privateLibrary.id}`, {
      method: "PATCH",
      headers: { ...as(teammate.email), "content-type": "application/json" },
      body: JSON.stringify({ scope: "public" }),
    })
    expect(widen.status).toBe(403)

    const publicLibrary = await (
      await app.request(
        "/v1/template-libraries",
        jsonAs(as(teammate.email), { title: "Public references", scope: "public" }),
      )
    ).json()
    const distribute = await app.request(
      `/v1/template-libraries/${publicLibrary.id}/entries`,
      jsonAs(as(teammate.email), entryBody),
    )
    expect(distribute.status).toBe(403)
    expect(await distribute.text()).toMatch(/cannot distribute/i)
  })

  it("serializes scope-sensitive mutations so validation cannot race publication", async () => {
    const source = await (
      await publishMarkdown(
        "# Internal starter\n\napi_key: sk_not_for_publication",
        {},
        as(owner.email),
      )
    ).json()
    const library = await (
      await app.request(
        "/v1/template-libraries",
        jsonAs(as(owner.email), { title: "Scope race regression", scope: "private" }),
      )
    ).json()
    const entryBody = {
      source_short_id: source.short_id,
      kind: "artifact",
      category: "Doc",
      title: "Internal starter",
      description: "Safe only while private.",
      outcome: "A private result.",
      sections: [],
      inputs: [],
      tags: [],
    }

    expect(
      await meta.acquireTemplateLibraryMutation(
        library.id,
        "held-by-test",
        new Date(Date.now() - 2 * 60_000).toISOString(),
      ),
    ).toBe(true)
    const blockedWiden = await app.request(`/v1/template-libraries/${library.id}`, {
      method: "PATCH",
      headers: { ...as(owner.email), "content-type": "application/json" },
      body: JSON.stringify({ scope: "public" }),
    })
    expect(blockedWiden.status).toBe(409)
    expect(await blockedWiden.text()).toMatch(/changing; retry/i)
    expect(
      (
        await app.request(
          `/v1/template-libraries/${library.id}/entries`,
          jsonAs(as(owner.email), entryBody),
        )
      ).status,
    ).toBe(409)
    await meta.releaseTemplateLibraryMutation(library.id, "held-by-test")

    expect(
      (
        await app.request(
          `/v1/template-libraries/${library.id}/entries`,
          jsonAs(as(owner.email), entryBody),
        )
      ).status,
    ).toBe(201)
    const widenAfterEntry = await app.request(`/v1/template-libraries/${library.id}`, {
      method: "PATCH",
      headers: { ...as(owner.email), "content-type": "application/json" },
      body: JSON.stringify({ scope: "public" }),
    })
    expect(widenAfterEntry.status).toBe(403)
  })

  it("does not let an unlisted world-link reader publish the source into the public catalog", async () => {
    const sourceJson = await (
      await publishAs(
        app,
        "# Unlisted launch plan",
        { workspace_access: "none", listed: "none", link_role: "viewer" },
        as(owner.email),
      )
    ).json()

    // Give the reader a different workspace in which they can publish, then
    // remove their standing access to the source workspace. Their only remaining
    // source grant is the unlisted world link.
    const createWorkspace = await app.request(
      "/v1/workspaces",
      jsonAs(as(teammate.email), { name: "Reader workspace" }),
    )
    expect(createWorkspace.status).toBe(201)
    const cookieValue = (createWorkspace.headers.get("set-cookie") ?? "").match(
      /derive_ws=([^;]+)/,
    )?.[1]
    expect(cookieValue).toBeTruthy()
    await meta.removeMembership("default", teammate.id)
    const readerHeaders = { ...as(teammate.email), cookie: `derive_ws=${cookieValue}` }
    const publicLibrary = await (
      await app.request(
        "/v1/template-libraries",
        jsonAs(readerHeaders, { title: "Public link imports", scope: "public" }),
      )
    ).json()

    const response = await app.request(
      `/v1/template-libraries/${publicLibrary.id}/entries`,
      jsonAs(readerHeaders, {
        source_short_id: sourceJson.short_id,
        kind: "artifact",
        category: "Doc",
        title: "Unlisted plan",
        description: "Must remain unlisted.",
        outcome: "No access widening.",
        sections: [],
        inputs: [],
        tags: [],
      }),
    )
    expect(response.status).toBe(403)
    expect(await response.text()).toMatch(/cannot distribute/i)
  })
})

describe("template libraries: release sequencing", () => {
  // The Postgres test store is a deferred proxy whose methods cannot be replaced
  // in-place. The predicate suite covers Postgres's 42P01 shape directly; this
  // integration case exercises the app-level 503 mapping against the replaceable
  // SQLite store used by PR previews.
  const releaseSequencingIt = process.env.DERIVE_TEST_DB === "pg" ? it.skip : it
  releaseSequencingIt("maps missing preview schema to an explicit temporary state", async () => {
    const previewUser: TestUser = {
      id: "u_tpl_preview",
      email: "preview@templates.test",
      name: "Preview tester",
    }
    const preview = makeAuthedApp("template-libraries-preview-schema", [previewUser])
    Object.assign(preview.meta, {
      listTemplateLibraries: async () => {
        throw Object.assign(new Error('relation "template_library" does not exist'), {
          code: "42P01",
        })
      },
    })

    const response = await preview.app.request("/v1/template-libraries", {
      headers: as(previewUser.email),
    })
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      code: "template_library_schema_unavailable",
    })
  })
})
