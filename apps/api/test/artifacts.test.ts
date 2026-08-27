import { zipSync } from "fflate"
import { describe, expect, it, vi } from "vitest"
import {
  app,
  as,
  jsonAs,
  makeAuthedApp,
  meta,
  postJson,
  publishAs,
  type TestUser,
  upload,
} from "./helpers"

describe("version sessions", () => {
  it("a named publish stores the checkpoint name on the version", async () => {
    const { short_id } = await (await upload("n.md", "v1")).json()
    await upload("n.md", "v2", { name: "Final draft" }, short_id)
    const a = await (await app.request(`/v1/artifacts/${short_id}`)).json()
    expect(a.versions[1].name).toBe("Final draft")
    expect(a.versions[0].name).toBeNull()
  })
})

describe("version-pinned export requests", () => {
  const owner: TestUser = { id: "export-owner", email: "export-owner@test.dev", name: "Owner" }
  const outsider: TestUser = {
    id: "export-outsider",
    email: "export-outsider@test.dev",
    name: "Outsider",
  }
  const { app: exportApp } = makeAuthedApp("exports-routes", [owner, outsider])

  it("pins a version and deduplicates a replay without enabling a renderer", async () => {
    const created = await (
      await publishAs(
        exportApp,
        '<script type="application/derive+json" data-name="series">[{"month":"Jan","value":4}]</script>',
        { title: "Export fixture", workspace_access: "none" },
        as(owner.email),
      )
    ).json()
    const request = () =>
      exportApp.request(`/v1/artifacts/${created.short_id}/exports`, {
        method: "POST",
        headers: { ...as(owner.email), "content-type": "application/json" },
        body: JSON.stringify({ kind: "chart_json", version: 1, dataSlot: "series" }),
      })
    const first = await request()
    const replay = await request()
    expect(first.status).toBe(202)
    expect(replay.status).toBe(202)
    const a = await first.json()
    const b = await replay.json()
    expect(a).toMatchObject({ version: 1, kind: "chart_json", status: "pending" })
    expect(b.id).toBe(a.id)
  })

  it("does not reveal a private export surface to another workspace member", async () => {
    const created = await (
      await publishAs(
        exportApp,
        "private",
        { title: "Private export", workspace_access: "none" },
        as(owner.email),
      )
    ).json()
    const response = await exportApp.request(`/v1/artifacts/${created.short_id}/exports`, {
      method: "POST",
      headers: { ...as(outsider.email), "content-type": "application/json" },
      body: JSON.stringify({ kind: "chart_json", dataSlot: "series" }),
    })
    expect(response.status).toBe(403)
  })

  it("lets an explicit viewer export readable truth, then rechecks access on download", async () => {
    const created = await (
      await publishAs(
        exportApp,
        '<script type="application/derive+json" data-name="series">[{"month":"Jan","value":4}]</script>',
        { title: "Shared export", workspace_access: "none" },
        as(owner.email),
      )
    ).json()
    const share = await exportApp.request(`/v1/artifacts/${created.short_id}/members`, {
      ...jsonAs(as(owner.email), { email: outsider.email, role: "viewer" }),
      method: "PUT",
    })
    expect(share.status).toBe(201)
    const requested = await exportApp.request(`/v1/artifacts/${created.short_id}/exports`, {
      method: "POST",
      headers: { ...as(outsider.email), "content-type": "application/json" },
      body: JSON.stringify({ kind: "chart_json", version: 1, dataSlot: "series" }),
    })
    expect(requested.status).toBe(202)
    const job = await requested.json()

    const revoke = await exportApp.request(
      `/v1/artifacts/${created.short_id}/members/${outsider.id}`,
      { method: "DELETE", headers: as(owner.email) },
    )
    expect(revoke.status).toBe(204)
    const direct = await exportApp.request(`/v1/exports/${job.id}/download`, {
      headers: as(outsider.email),
    })
    expect(direct.status).toBe(404)
  })
})

describe("inline edit version coalescing", () => {
  const owner: TestUser = { id: "inline-owner", email: "inline-owner@test.dev", name: "Owner" }
  const editor: TestUser = {
    id: "inline-editor",
    email: "inline-editor@test.dev",
    name: "Editor",
  }
  const { app: inlineApp } = makeAuthedApp("inline-version-coalescing", [owner, editor], "editor")
  const { app: timedApp } = makeAuthedApp("inline-version-timeout", [owner])

  const edit = (
    shortId: string,
    baseVersion: number,
    oldStr: string,
    newStr: string,
    headers: Record<string, string>,
    target = inlineApp,
  ) => {
    const form = new FormData()
    form.append("edits", JSON.stringify([{ old_str: oldStr, new_str: newStr }]))
    form.append("base_version", String(baseVersion))
    form.append("message", "Inline edit")
    form.append("coalesce", "true")
    return target.request(`/v1/artifacts/${shortId}/versions`, {
      method: "POST",
      body: form,
      headers,
    })
  }

  it("keeps consecutive edits by one person in the current version", async () => {
    const created = await (
      await publishAs(inlineApp, "<h1>One</h1>", { title: "Working page" }, as(owner.email))
    ).json()
    const saved = await edit(created.short_id, 1, "One", "Two", as(owner.email))
    expect(saved.status).toBe(201)
    expect((await saved.json()).current_version).toBe(1)

    const detail = await (
      await inlineApp.request(`/v1/artifacts/${created.short_id}`, {
        headers: as(owner.email),
      })
    ).json()
    expect(detail.versions).toHaveLength(1)
    expect(
      await (
        await inlineApp.request(`/v1/artifacts/${created.short_id}/content`, {
          headers: as(owner.email),
        })
      ).text(),
    ).toContain("<h1>Two</h1>")
  })

  it("starts a new version when another person edits", async () => {
    const created = await (
      await publishAs(inlineApp, "<h1>A</h1>", { title: "Shared page" }, as(owner.email))
    ).json()
    const saved = await edit(created.short_id, 1, "A", "B", as(editor.email))
    expect(saved.status).toBe(201)
    expect((await saved.json()).current_version).toBe(2)
  })

  it("starts a new version after five minutes", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-08-22T12:00:00.000Z"))
      const created = await (
        await publishAs(timedApp, "<h1>Early</h1>", { title: "Timed page" }, as(owner.email))
      ).json()
      vi.advanceTimersByTime(5 * 60_000 + 1)

      const saved = await edit(created.short_id, 1, "Early", "Later", as(owner.email), timedApp)
      expect(saved.status).toBe(201)
      expect((await saved.json()).current_version).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps named checkpoints immutable", async () => {
    const created = await (
      await publishAs(
        inlineApp,
        "<h1>Checkpoint</h1>",
        { title: "Pinned page", name: "First draft" },
        as(owner.email),
      )
    ).json()
    const saved = await edit(created.short_id, 1, "Checkpoint", "Changed", as(owner.email))
    expect(saved.status).toBe(201)
    expect((await saved.json()).current_version).toBe(2)
  })
})

describe("version restore", () => {
  it("restores a past version as a new current revision", async () => {
    const { short_id } = await (await upload("r.md", "alpha")).json()
    await upload("r.md", "beta", {}, short_id)
    const res = await postJson(`/v1/artifacts/${short_id}/restore`, { version: 1 })
    expect(res.status).toBe(201)
    const a = await res.json()
    expect(a.current_version).toBe(3)
    expect(a.versions[2].message).toBe("Restored v1")
  })

  it("reproduces the restored version's content exactly", async () => {
    const { short_id } = await (await upload("rc.md", "# original")).json()
    await upload("rc.md", "# changed", {}, short_id)
    await postJson(`/v1/artifacts/${short_id}/restore`, { version: 1 })
    const current = await (await app.request(`/v1/artifacts/${short_id}/content`)).text()
    expect(current).toBe("# original")
  })

  it("preserves the original version after restore (history not rewritten)", async () => {
    const { short_id } = await (await upload("rp.md", "one")).json()
    await upload("rp.md", "two", {}, short_id)
    await postJson(`/v1/artifacts/${short_id}/restore`, { version: 1 })
    expect(await (await app.request(`/v1/artifacts/${short_id}/content?v=1`)).text()).toBe("one")
    expect(await (await app.request(`/v1/artifacts/${short_id}/content?v=2`)).text()).toBe("two")
  })

  it("404s restoring an unknown version", async () => {
    const { short_id } = await (await upload("r4.md", "x")).json()
    expect((await postJson(`/v1/artifacts/${short_id}/restore`, { version: 99 })).status).toBe(404)
  })
})

describe("publish html file", () => {
  let shortId: string

  it("publishes and returns a stable url", async () => {
    const res = await upload(
      "q1-review.html",
      "<h1>Q1 Review</h1><script>document.title='hi'</script>",
      {
        title: "Q1 Review",
      },
    )
    expect(res.status).toBe(201)
    const json = await res.json()
    shortId = json.short_id
    expect(json.url).toBe(`http://derive.test/artifacts/q1-review-${shortId}`)
    expect(json.kind).toBe("file")
    expect(json.current_version).toBe(1)
  })

  it("returns detection-driven advisories (here: styled page publishing into the reflow injection)", async () => {
    const res = await upload(
      "noviewport.html",
      "<html><head></head><body><h1>x</h1></body></html>",
      {
        title: "No viewport",
      },
    )
    const json = await res.json()
    expect(json.advisories).toHaveLength(1)
    expect(json.advisories[0]).toContain("viewport")

    // A page that declared its viewport hears nothing — the field is absent entirely.
    const quiet = await upload(
      "viewport.html",
      '<html><head><meta name="viewport" content="width=device-width"></head><body>x</body></html>',
      { title: "Viewport" },
    )
    expect((await quiet.json()).advisories).toBeUndefined()
  })

  it("advises a DECK too, not just text/html (regression)", async () => {
    // The gate here used to compare content_type to "text/html" literally, so a deck —
    // text/x-derive-deck — came back with no advisories at all over REST, while the same
    // bytes over MCP (gated on kind alone) got them. A deck is exactly as capable of
    // embedding an expiring upload URL or a broken blob ref as any other page.
    const deck =
      '<!doctype html><html><head><meta name="viewport" content="width=device-width">' +
      "<title>D</title></head><body>" +
      '<section class="slide" data-derive-slide="0"><h1>One</h1>' +
      '<img src="https://x.test/v1/assets/t/expiring-token/shot.png"></section>' +
      '<section class="slide" data-derive-slide="1"><h2>Two</h2></section>' +
      '<script>parent.postMessage({source:"derive-deck",type:"state",i:0,total:2},"*")</script>' +
      "</body></html>"
    const res = await upload("deck.html", deck, { title: "Deck" })
    const json = await res.json()
    // Typed as a deck — otherwise this passes vacuously through the text/html branch.
    expect(json.current_content_type).toBe("text/x-derive-deck")
    expect(json.advisories?.some((a: string) => a.includes("v1/assets/t/"))).toBe(true)
  })

  it("echoes the stored content's sha256 so a caller can verify byte integrity", async () => {
    const content = "<h1>Checksum me</h1>"
    const res = await upload("sum.html", content, { title: "Sum" })
    const json = await res.json()
    const expected = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)),
    ).toString("hex")
    // Computed independently here: the echoed hash must be the sha256 of the
    // exact bytes stored, not of anything the server re-encoded.
    expect(json.content_sha256).toBe(expected)
  })

  it("the REST publish receipt lists asserted facts only, never the host's $rows", async () => {
    // The 201 body is a reward surface — found in review after the first inventory
    // missed it. The stored rows now include $stats (every html page derives one), and
    // the receipt must show the author's facts, not the host congratulating itself.
    const content =
      "<h1>Receipt</h1><h2>Body</h2>" +
      '<script type="application/derive-facts" data-fact="checks">{"pass":3}</script>'
    const json = await (await upload("receipt.html", content, { title: "Receipt" })).json()
    expect(json.data.map((d: { fact: string }) => d.fact)).toEqual(["checks"])
  })

  it("serves artifact metadata and sandboxed raw content", async () => {
    // The viewer at /artifacts/:ref is the SPA (client-rendered); the server exposes the
    // artifact's metadata over the data API and the bytes over the sandboxed /raw.
    const detail = await app.request(`/v1/artifacts/${shortId}`)
    expect(detail.status).toBe(200)
    expect((await detail.json()).title).toBe("Q1 Review")

    const raw = await app.request(`/raw/${shortId}/v/1/index.html`)
    expect(raw.status).toBe(200)
    expect(raw.headers.get("content-security-policy")).toContain("sandbox allow-scripts")
    expect(raw.headers.get("content-security-policy")).not.toContain("allow-same-origin")
    expect(await raw.text()).toContain("<h1>Q1 Review</h1>")
  })

  it("republishes as v2 while @v1 stays immutable", async () => {
    const res = await upload(
      "q1-review.html",
      "<h1>Q1 Review v2</h1>",
      { message: "address review" },
      shortId,
    )
    expect(res.status).toBe(201)
    expect((await res.json()).current_version).toBe(2)

    expect(await (await app.request(`/raw/${shortId}/v/1/index.html`)).text()).toContain(
      "Q1 Review</h1>",
    )
    expect(await (await app.request(`/raw/${shortId}/v/2/index.html`)).text()).toContain(
      "Q1 Review v2",
    )
  })
})

describe("linked bundles", () => {
  it("returns the validated workflow Preview on the shared artifact detail", async () => {
    const manifest = {
      schema: "derive.linked-bundle/v1",
      purpose: "Publish a reviewed signal brief.",
      members: [],
      diagrams: [
        {
          id: "signal-brief",
          title: "Reviewed signal brief",
          type: "graph",
          nodes: [
            { id: "draft", label: "Draft", state: "pending" },
            { id: "review", label: "Review", state: "pending" },
            { id: "publish", label: "Publish", state: "pending" },
            { id: "stop", label: "Stop", state: "pending" },
          ],
          edges: [
            { from: "draft", to: "review", label: "ready" },
            { from: "review", to: "publish", label: "approve" },
            { from: "review", to: "stop", label: "stop" },
          ],
        },
      ],
    }
    const workflow = {
      schema: "derive.workflow/v1",
      purpose: manifest.purpose,
      forbidden: ["Publish without approval"],
      diagrams: [
        {
          id: "signal-brief",
          entry: "draft",
          nodes: [
            {
              id: "draft",
              kind: "context",
              context_ref: "signal-writer",
              instruction: "Draft the signal brief.",
              result: "A reviewable brief",
            },
            {
              id: "review",
              kind: "human",
              decision: "Approve or stop",
              options: ["approve", "stop"],
              resume: "The reviewer chooses",
            },
            {
              id: "publish",
              kind: "context",
              context_ref: "artifact-publisher",
              instruction: "Publish the approved brief.",
              result: "A published brief",
              terminal: true,
              effects: [
                {
                  kind: "write",
                  description: "Publish the brief",
                  gate: "human",
                  approval_ref: "review",
                },
              ],
            },
            {
              id: "stop",
              kind: "terminal",
              result: "The workflow is stopped without publishing",
            },
          ],
          routes: [
            { from: "draft", to: "review", when: "always" },
            { from: "review", to: "publish", when: "approve" },
            { from: "review", to: "stop", when: "stop" },
          ],
          scenarios: [
            {
              id: "expected",
              kind: "expected",
              path: ["draft", "review", "publish"],
              outcome: "The approved brief is published",
            },
            {
              id: "failure",
              kind: "failure",
              path: ["draft"],
              outcome: "The failed context stays visible",
            },
            {
              id: "human",
              kind: "human",
              path: ["draft", "review", "stop"],
              outcome: "The reviewer stops the workflow",
            },
          ],
        },
      ],
    }
    const html =
      '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body>' +
      `<script type="application/derive-facts" data-fact="bundle-manifest">${JSON.stringify(manifest)}</script>` +
      `<script type="application/derive-facts" data-fact="workflow-definition">${JSON.stringify(workflow)}</script>` +
      "</body></html>"
    const published = await (
      await upload("workflow.html", html, { title: "Signal workflow" })
    ).json()

    const detail = await (await app.request(`/v1/artifacts/${published.short_id}`)).json()
    expect(detail.workflow_preview).toMatchObject({
      status: "ready",
      execution_started: false,
      purpose: manifest.purpose,
      diagrams: [
        {
          id: "signal-brief",
          title: "Reviewed signal brief",
          will_do: ["Draft — A reviewable brief", "Publish — A published brief"],
          will_pause: ["Review — Approve or stop; resume: The reviewer chooses"],
          side_effects: ["Publish the brief — authorized at Review"],
        },
      ],
      cannot_do: ["Publish without approval"],
    })
  })

  it("resolves readable members and leaves missing ones explicit", async () => {
    const member = await (await upload("brief.md", "# Brief", { title: "Product brief" })).json()
    const manifest = {
      schema: "derive.linked-bundle/v1",
      purpose: "Keep the improvement loop and its outputs together.",
      members: [
        { id: "brief", ref: member.short_id, label: "Brief", role: "output" },
        { id: "evidence", ref: "nope1234", label: "Evidence" },
      ],
      diagrams: [
        {
          id: "improve",
          title: "Improve until confident",
          type: "loop",
          tier: "balanced",
          goal: "Make the brief decision-ready",
          evaluate: "Check material claims",
          stop: "No material objections remain",
          nodes: [
            {
              id: "revise",
              label: "Revise",
              member: "brief",
              role: "draft owner",
              tier: "expert",
              state: "active",
              basis_version: 1,
              note: "Address the evidence objection",
              confidence: {
                level: "medium",
                basis: "One evidence objection remains unresolved.",
              },
              help: {
                needed: true,
                question: "Which source resolves the objection?",
                can_continue: "Tighten uncontested sections.",
              },
            },
            { id: "check", label: "Check", member: "evidence" },
          ],
          edges: [
            { from: "revise", to: "check" },
            { from: "check", to: "revise", label: "improve" },
          ],
        },
      ],
    }
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><a href="/artifacts/${member.short_id}">Brief</a><a href="/artifacts/nope1234">Evidence</a><script type="application/derive-facts" data-fact="bundle-manifest">${JSON.stringify(manifest)}</script></body></html>`
    const published = await (await upload("bundle.html", html, { title: "Launch loop" })).json()
    expect(published.current_content_type).toBe("text/x-derive-linked-bundle")

    const detail = await (await app.request(`/v1/artifacts/${published.short_id}`)).json()
    expect(detail.linked_bundle).toMatchObject({
      purpose: manifest.purpose,
      members: [
        {
          id: "brief",
          available: true,
          title: "Product brief",
          content_type: "text/markdown",
          current_version: 1,
          updated_at: expect.any(String),
        },
        { id: "evidence", available: false },
      ],
      diagrams: [
        {
          id: "improve",
          type: "loop",
          tier: "balanced",
          nodes: [
            {
              id: "revise",
              role: "draft owner",
              tier: "expert",
              state: "active",
              basis_version: 1,
              note: "Address the evidence objection",
              confidence: {
                level: "medium",
                basis: "One evidence objection remains unresolved.",
              },
              help: {
                needed: true,
                question: "Which source resolves the objection?",
                can_continue: "Tighten uncontested sections.",
              },
            },
            { id: "check" },
          ],
        },
      ],
    })
    expect(detail.linked_bundle.members[1]).not.toHaveProperty("title")
    expect(detail.linked_bundle.members[1]).not.toHaveProperty("url")
    expect(detail.linked_bundle.members[1]).not.toHaveProperty("current_version")
    expect(detail.linked_bundle.members[1]).not.toHaveProperty("updated_at")
  })

  it("does not leak metadata for a member the bundle reader cannot open", async () => {
    const users = [
      { id: "lb-owner", email: "bundle-owner@x.test", name: "Bundle Owner" },
      { id: "lb-secret", email: "secret-owner@x.test", name: "Secret Owner" },
    ]
    const { app: authed } = makeAuthedApp("linked-bundle-member-gate", users, "editor")
    const secret = await (
      await publishAs(
        authed,
        "# Secret evidence",
        {
          title: "Secret evidence",
          workspace_access: "none",
          link_role: "none",
          listed: "none",
        },
        as("secret-owner@x.test"),
      )
    ).json()
    const manifest = {
      schema: "derive.linked-bundle/v1",
      purpose: "Coordinate work without widening member access.",
      members: [{ id: "secret", ref: secret.short_id, label: "Private evidence" }],
    }
    const html = `<!doctype html><html><body><a href="/artifacts/${secret.short_id}">Private evidence</a><script type="application/derive-facts" data-fact="bundle-manifest">${JSON.stringify(manifest)}</script></body></html>`
    const bundle = await (
      await publishAs(authed, html, { title: "Private-aware bundle" }, as("bundle-owner@x.test"))
    ).json()
    const detail = await (
      await authed.request(`/v1/artifacts/${bundle.short_id}`, {
        headers: as("bundle-owner@x.test"),
      })
    ).json()
    expect(detail.linked_bundle.members).toEqual([
      expect.objectContaining({ id: "secret", label: "Private evidence", available: false }),
    ])
    expect(detail.linked_bundle.members[0]).not.toHaveProperty("title")
    expect(detail.linked_bundle.members[0]).not.toHaveProperty("url")
  })

  it("includes open feedback counts for readable members without copying comments", async () => {
    const user = { id: "lb-reviewer", email: "reviewer@x.test", name: "Reviewer" }
    const { app: authed, meta: authedMeta } = makeAuthedApp("linked-bundle-counts", [user])
    const member = await (
      await publishAs(authed, "# Brief", { title: "Brief" }, as(user.email))
    ).json()
    const record = await authedMeta.getByShortId(member.short_id)
    if (!record) throw new Error("member missing")
    await authedMeta.createComment({
      id: "c_bundle_member",
      artifact_id: record.id,
      thread_id: "c_bundle_member",
      base_version: 1,
      path: null,
      anchor: null,
      body_md: "Please verify this claim",
      author: user.name,
      author_id: user.id,
    })
    const manifest = {
      schema: "derive.linked-bundle/v1",
      purpose: "Review one living brief.",
      members: [{ id: "brief", ref: member.short_id, label: "Brief" }],
    }
    const html = `<a href="/artifacts/${member.short_id}">Brief</a><script type="application/derive-facts" data-fact="bundle-manifest">${JSON.stringify(manifest)}</script>`
    const bundle = await (
      await publishAs(authed, html, { title: "Review bundle" }, as(user.email))
    ).json()
    const detail = await (
      await authed.request(`/v1/artifacts/${bundle.short_id}`, { headers: as(user.email) })
    ).json()
    expect(detail.linked_bundle.members[0].open_comment_count).toBe(1)
  })
})

describe("publish static bundle (astro-style dist)", () => {
  let shortId: string

  it("publishes a zip with nested assets and pretty urls", async () => {
    const zip = zipSync({
      "index.html": new TextEncoder().encode("<h1>Site</h1><script src='/assets/app.js'></script>"),
      "assets/app.js": new TextEncoder().encode("console.log('hi')"),
      "about/index.html": new TextEncoder().encode("<h1>About</h1>"),
    })
    const res = await upload("dist.zip", zip, { title: "My Site", spa: "true" })
    expect(res.status).toBe(201)
    const json = await res.json()
    shortId = json.short_id
    expect(json.kind).toBe("bundle")
  })

  it("serves nested assets with correct mime", async () => {
    const js = await app.request(`/raw/${shortId}/v/1/assets/app.js`)
    expect(js.status).toBe(200)
    expect(js.headers.get("content-type")).toContain("text/javascript")
  })

  it("rewrites root-absolute urls so assets resolve under the raw prefix", async () => {
    const html = await (await app.request(`/raw/${shortId}/v/1/index.html`)).text()
    expect(html).toContain(`src='/raw/${shortId}/v/1/assets/app.js'`)
    expect(html).not.toContain(`src='/assets/app.js'`)
  })

  it("supports pretty urls and spa fallback", async () => {
    const about = await app.request(`/raw/${shortId}/v/1/about`)
    expect(await about.text()).toContain("<h1>About</h1>")

    const fallback = await app.request(`/raw/${shortId}/v/1/some/client/route`)
    expect(fallback.status).toBe(200)
    expect(await fallback.text()).toContain("<h1>Site</h1>")
  })
})

describe("publish markdown", () => {
  it("renders sanitized html and serves raw source", async () => {
    const md = "# Notes\n\nSome *text*.\n\n<script>alert(1)</script>"
    const res = await upload("notes.md", md)
    const { short_id } = await res.json()

    const rendered = await app.request(`/raw/${short_id}/v/1/index.html`)
    const html = await rendered.text()
    expect(html).toContain("<h1>Notes</h1>")
    expect(html).not.toContain("<script>alert")

    const raw = await app.request(`/raw/${short_id}/v/1/raw.md`)
    expect(raw.headers.get("content-type")).toContain("text/markdown")
    expect(await raw.text()).toBe(md)
  })
})

// The live editor preview endpoint: renders a markdown draft to the exact
// published HTML (same renderMarkdown), stateless, signed-in only.
describe("live editor preview (/v1/preview)", () => {
  const owner: TestUser = { id: "u_prev", email: "prev@derive.test", name: "Prev" }
  const { app: authed } = makeAuthedApp("preview-org", [owner])

  it("renders a markdown draft to HTML for a signed-in user", async () => {
    const r = await authed.request(
      "/v1/preview",
      jsonAs(as(owner.email), { source: "# Hi\n\nsome **bold** text", title: "Draft" }),
    )
    expect(r.status).toBe(200)
    const { html } = (await r.json()) as { html: string }
    expect(html).toContain("<!doctype html>")
    expect(html).toContain("<h1>Hi</h1>")
    expect(html).toContain("<strong>bold</strong>")
  })

  it("refuses an unauthenticated caller (401)", async () => {
    const r = await app.request("/v1/preview", jsonAs({}, { source: "# x" }))
    expect(r.status).toBe(401)
  })
})

describe("api surface", () => {
  it("returns artifact json with version history", async () => {
    const res = await upload("doc.html", "<p>one</p>", { title: "Doc" })
    const { short_id } = await res.json()
    await upload("doc.html", "<p>two</p>", { message: "tweak" }, short_id)

    const meta = await (await app.request(`/v1/artifacts/${short_id}`)).json()
    expect(meta.current_version).toBe(2)
    expect(meta.versions).toHaveLength(2)
    expect(meta.versions[1].message).toBe("tweak")
  })

  it("renames on republish when a title is sent, keeps it otherwise; short_id is stable", async () => {
    const { short_id, title } = await (await upload("ren.md", "v1", { title: "First name" })).json()
    expect(title).toBe("First name")
    // The in-browser editor republishes with the (editable) title → rename.
    const v2 = await (await upload("ren.md", "v2", { title: "Renamed" }, short_id)).json()
    expect(v2.title).toBe("Renamed")
    expect(v2.current_version).toBe(2)
    // A republish without a title (e.g. a plain CLI `derive publish --id`) leaves it.
    const v3 = await (await upload("ren.md", "v3", {}, short_id)).json()
    expect(v3.title).toBe("Renamed")
    // The short_id never changes, so every old link still resolves after a rename.
    expect(v3.short_id).toBe(short_id)
  })

  it("reads back source content for any version", async () => {
    const res = await upload("read.md", "# one", { title: "Read" })
    const { short_id } = await res.json()
    await upload("read.md", "# two", { message: "v2" }, short_id)

    const cur = await app.request(`/v1/artifacts/${short_id}/content`)
    expect(cur.status).toBe(200)
    expect(cur.headers.get("x-derive-version")).toBe("2")
    expect(await cur.text()).toBe("# two")

    const v1 = await app.request(`/v1/artifacts/${short_id}/content?v=1`)
    expect(await v1.text()).toBe("# one")
  })

  it("reads back a bundle's entry document", async () => {
    const zip = zipSync({ "index.html": new TextEncoder().encode("<h1>Entry</h1>") })
    const { short_id } = await (await upload("site.zip", zip)).json()
    const content = await app.request(`/v1/artifacts/${short_id}/content`)
    expect(content.headers.get("x-derive-kind")).toBe("bundle")
    expect(await content.text()).toBe("<h1>Entry</h1>")
  })

  it("listArtifacts filters by content type at the store", async () => {
    // find(skills:true) used to page the whole library and filter in memory; the
    // store-level filter is what makes a skills listing cheap. Both dialects run
    // this file (sqlite by default, pg via DERIVE_TEST_DB=pg).
    const zip = zipSync({
      "SKILL.md": new TextEncoder().encode("---\nname: filter-probe\n---\n# P"),
    })
    const { short_id: skillShort } = await (
      await upload("skill.zip", zip, { title: "Filter probe" })
    ).json()
    await upload("plain-probe.md", "# plain", { title: "Plain probe" })
    const rows = await meta.listArtifacts({ orgId: "default", contentType: "derive/skill" })
    expect(rows.some((a) => a.short_id === skillShort)).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((a) => a.current_content_type === "derive/skill")).toBe(true)
  })

  it("diffs two versions as text and json", async () => {
    const res = await upload("d.md", "# title\nalpha", { title: "D" })
    const { short_id } = await res.json()
    await upload("d.md", "# title\nbeta", { message: "v2" }, short_id)

    const txt = await app.request(`/v1/artifacts/${short_id}/diff`)
    expect(txt.status).toBe(200)
    expect(txt.headers.get("x-derive-from")).toBe("1")
    expect(txt.headers.get("x-derive-to")).toBe("2")
    const body = await txt.text()
    expect(body).toContain("  # title")
    expect(body).toContain("- alpha")
    expect(body).toContain("+ beta")

    const json = await (await app.request(`/v1/artifacts/${short_id}/diff?format=json`)).json()
    expect(json.from).toBe(1)
    expect(json.to).toBe(2)
    expect(json.ops).toContainEqual({ t: "add", line: "beta" })
  })

  it("404s on unknown artifacts and rejects empty zips", async () => {
    expect((await app.request("/v1/artifacts/zzzzzzzz")).status).toBe(404)
    const bad = await upload("dist.zip", zipSync({}))
    expect(bad.status).toBe(400)
  })
})

describe("server-side search + cursor pagination", () => {
  const putTags = (shortId: string, tags: string[]) =>
    app.request(`/v1/artifacts/${shortId}/tags`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags }),
    })

  it("searches artifact titles, tags, and collection titles server-side", async () => {
    const titled = await (await upload("s1.md", "x", { title: "Quarterly ZZUNIQUE Report" })).json()
    await upload("s2.md", "x", { title: "Totally unrelated" })
    const r = await (await app.request("/v1/artifacts?query=zzunique")).json()
    const titles = r.artifacts.map((a: { title: string | null }) => a.title)
    expect(titles).toContain("Quarterly ZZUNIQUE Report")

    await putTags(titled.short_id, ["Roadmap Signal"])
    const byTag = await (await app.request("/v1/artifacts?query=roadmap")).json()
    expect(byTag.artifacts.map((a: { short_id: string }) => a.short_id)).toContain(titled.short_id)

    const collection = await meta.createCollection({
      id: "col_search_materials",
      org_id: "default",
      title: "Customer Materials",
      created_by: "owner",
    })
    const titledRecord = await meta.getByShortId(titled.short_id)
    expect(titledRecord).not.toBeNull()
    if (!titledRecord) throw new Error("published search fixture was not stored")
    await meta.addCollectionItem(collection.id, titledRecord.id)
    const byCollection = await (await app.request("/v1/artifacts?query=customer")).json()
    expect(byCollection.artifacts.map((a: { short_id: string }) => a.short_id)).toContain(
      titled.short_id,
    )
  })

  it("paginates newest-first with a keyset cursor (no overlap)", async () => {
    for (const n of ["A", "B", "C"]) await upload(`pg${n}.md`, "x", { title: `PGSEED ${n}` })
    const p1 = await (await app.request("/v1/artifacts?query=PGSEED&limit=2")).json()
    expect(p1.artifacts).toHaveLength(2)
    expect(typeof p1.next_cursor).toBe("string")
    const p2 = await (
      await app.request(
        `/v1/artifacts?query=PGSEED&limit=2&cursor=${encodeURIComponent(p1.next_cursor)}`,
      )
    ).json()
    expect(p2.artifacts).toHaveLength(1)
    expect(p2.next_cursor).toBeNull()
    const seen = new Set(p1.artifacts.map((a: { short_id: string }) => a.short_id))
    expect(p2.artifacts.some((a: { short_id: string }) => seen.has(a.short_id))).toBe(false)
  })

  it("filters by ?tag= server-side", async () => {
    const { short_id } = await (await upload("tg.md", "x", { title: "Tagged one" })).json()
    await putTags(short_id, ["serverfilter"])
    const r = await (await app.request("/v1/artifacts?tag=serverfilter")).json()
    expect(r.artifacts.map((a: { short_id: string }) => a.short_id)).toEqual([short_id])
  })
})

// The list endpoint sends `my_role` per row so the library UI can gate the
// card quick-actions menu (tags/delete) without opening the artifact. Baseline
// standing only (workspace membership + general-access floor); the detail
// response stays authoritative for per-artifact shares.
describe("list rows carry my_role", () => {
  const users = [
    { id: "lr1", email: "list-owner@x.test", name: "Owner" },
    { id: "lr2", email: "list-commenter@x.test", name: "Commenter" },
  ]

  it("workspace members see their baseline role on every row", async () => {
    const { app: a } = makeAuthedApp("myrole-list", users, "commenter")
    await publishAs(a, "<h1>role row</h1>", { title: "Role row" }, as("list-owner@x.test"))
    const owner = await (
      await a.request("/v1/artifacts", { headers: as("list-owner@x.test") })
    ).json()
    expect(owner.artifacts.length).toBeGreaterThan(0)
    expect(owner.artifacts.every((r: { my_role?: string }) => r.my_role === "owner")).toBe(true)
    const member = await (
      await a.request("/v1/artifacts", { headers: as("list-commenter@x.test") })
    ).json()
    expect(member.artifacts.every((r: { my_role?: string }) => r.my_role === "commenter")).toBe(
      true,
    )
  })
})

// Renaming is metadata: it must not mint a version. Before this route the only way
// to rename was to republish the whole document, which left an empty-diff version in
// the history and told every reader the document had changed.
describe("PATCH /v1/artifacts/{shortId} — rename", () => {
  const patchTitle = (shortId: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(`/v1/artifacts/${shortId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })

  it("renames without adding a version, and re-derives the url name", async () => {
    const { short_id } = await (await upload("r.md", "hello", { title: "Old name" })).json()
    const before = await (await app.request(`/v1/artifacts/${short_id}`)).json()
    const r = await patchTitle(short_id, { title: "  A better name  " })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ title: "A better name", slug: "a-better-name" })
    const after = await (await app.request(`/v1/artifacts/${short_id}`)).json()
    expect(after.title).toBe("A better name")
    expect(after.current_version).toBe(before.current_version)
    expect(after.versions).toHaveLength(before.versions.length)
  })

  it("refuses an empty title", async () => {
    const { short_id } = await (await upload("r3.md", "hello", { title: "Keep" })).json()
    expect((await patchTitle(short_id, { title: "   " })).status).toBe(400)
    expect((await patchTitle(short_id, { title: "" })).status).toBe(400)
    const a = await (await app.request(`/v1/artifacts/${short_id}`)).json()
    expect(a.title).toBe("Keep")
  })

  it("needs publish rights — a commenter can't rename", async () => {
    const { app: a } = makeAuthedApp(
      "rename-perm",
      [
        { id: "rn1", email: "rename-owner@x.test", name: "Owner" },
        { id: "rn2", email: "rename-commenter@x.test", name: "Commenter" },
      ],
      "commenter",
    )
    const pub = await publishAs(a, "<h1>hi</h1>", { title: "Owned" }, as("rename-owner@x.test"))
    const { short_id } = await pub.json()
    const r = await a.request(`/v1/artifacts/${short_id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as("rename-commenter@x.test") },
      body: JSON.stringify({ title: "Nope" }),
    })
    expect(r.status).toBe(403)
  })
})

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
describe("renaming an artifact re-derives its slug", () => {
  const owner: TestUser = { id: "u_slug", email: "slug@derive.test", name: "Owner" }

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
})
